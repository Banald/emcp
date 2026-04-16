# Tool authoring guide

This document is the contract for adding tools to `src/tools/`. Read it before creating or modifying a tool.

## The drop-in model

A tool is a single `.ts` file in `src/tools/` (or a subdirectory). It exports a `ToolDefinition` as the default export. The server discovers tools at startup by scanning the directory tree — there is no manifest, no registry to update. Drop the file in, restart the server, the tool is live.

## File layout

```
src/tools/
├── fetch-news.ts         # Top-level tool
├── fetch-news.test.ts    # Co-located test (excluded from discovery)
└── github/               # Subdirectory grouping for related tools
    ├── create-issue.ts
    ├── create-issue.test.ts
    ├── list-issues.ts
    └── list-issues.test.ts
```

`src/tools/` contains only real tool files plus their colocated tests. The tool contract (`ToolDefinition`, `ToolContext`, `CallToolResult`) lives in `src/shared/tools/types.ts`; the discovery logic in `src/shared/tools/loader.ts`. Tool authors should not modify either. Shared network helpers used by tools (e.g. SSRF guards) live in `src/shared/net/`.

**Files excluded from discovery** (defensive — these should not appear under `src/tools/` at all, but the loader guards against mistakes): `types.ts`, `loader.ts`, anything ending in `.test.ts`, anything starting with `_`.

## Naming conventions

- **File name**: `kebab-case.ts` matching the tool name (`fetch-news.ts` → tool name `fetch-news`).
- **Tool name** (`name` field): `kebab-case`, globally unique across all tools. For grouped tools, prefix with the group: `github-create-issue`, not just `create-issue`.
- **Title** (`title` field): Human-readable, title case: `"Fetch News"`, `"Create GitHub Issue"`.
- **Description**: This is what the LLM reads to decide when to invoke the tool. Be specific and concrete. Bad: `"Get data"`. Good: `"Fetch the 10 most recent news articles matching a topic from the local news cache. Returns title, URL, source, and published date."`

## The `ToolContext` interface

Every handler receives a `ToolContext` as its second argument. This is the formal contract — defined in `src/shared/tools/types.ts`:

```typescript
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

export interface AuthenticatedKey {
  readonly id: string;          // UUID from api_keys.id
  readonly prefix: string;      // e.g. 'mcp_live_k7Hj9mNq' — safe to log
  readonly name: string;        // human label
  readonly rateLimitPerMinute: number;
}

export interface ToolContext {
  readonly logger: Logger;                       // Pino child with request_id + tool_name pre-bound
  readonly db: Pool;                             // pg connection pool
  readonly redis: Redis;                         // ioredis client (cache / rate limiting)
  readonly apiKey: AuthenticatedKey;             // the authenticated key (never the raw secret)
  readonly requestId: string;                    // UUID for log correlation
  readonly signal: AbortSignal;                  // aborts on client disconnect or shutdown
}
```

Honor `ctx.signal` for any long operation — pass it to `fetch()`, check it in loops, and abort cleanly. The server uses it during graceful shutdown.

Tools do **not** receive a queue handle. If a tool's job is to surface data produced by a background worker, the tool reads it from Postgres — tools never invoke or enqueue workers directly. See `docs/WORKER_AUTHORING.md` for the worker side of this boundary.

## The tool template

Copy this when creating a new tool:

```typescript
// src/tools/example-tool.ts
import { z } from 'zod';
import type { ToolDefinition, ToolContext, CallToolResult } from '../shared/tools/types.ts';

const inputSchema = {
  query: z.string().min(1).max(500).describe('The search query'),
  limit: z.number().int().positive().max(100).default(10).describe('Max results'),
};

const tool: ToolDefinition<typeof inputSchema> = {
  name: 'example-tool',
  title: 'Example Tool',
  description:
    'One or two sentences describing exactly what this tool does, what inputs it takes, and what it returns. The LLM uses this to decide when to call.',
  inputSchema,
  // Optional: declare structured output for clients that want machine-readable results
  // outputSchema: { results: z.array(z.object({ id: z.string(), title: z.string() })) },
  // Optional: per-tool rate limit (overrides the per-key default for this tool only)
  // rateLimit: { perMinute: 10 },
  handler: async ({ query, limit }, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info({ query, limit }, 'example-tool invoked');

    const { rows } = await ctx.db.query(
      'SELECT id, title FROM example WHERE topic = $1 LIMIT $2',
      [query, limit],
    );

    return {
      content: [{ type: 'text', text: JSON.stringify({ results: rows }) }],
      // structuredContent: { results: rows },  // populate if outputSchema declared
    };
  },
};

export default tool;
```

## Input schema rules

- Use Zod. Always.
- Always call `.describe()` on every field — descriptions are surfaced to the LLM in the JSON Schema and dramatically improve tool selection accuracy.
- Set explicit bounds: `.min()`, `.max()`, `.int()`, `.positive()`. Unbounded inputs are a security smell.
- Prefer `.default()` over making fields optional when there's a sensible default.
- For URL / hostname fields that will be fetched, call `assertPublicHostname()` from `src/shared/net/ssrf.ts` before issuing any request.
- **Never** accept arbitrary JSON blobs. If a field needs structure, define the structure with Zod.

### Marking sensitive fields

Fields containing credentials, tokens, or PII should be tagged with `.meta({ sensitive: true })`. The logging middleware reads this metadata and redacts these fields from operational logs automatically.

```typescript
const inputSchema = {
  webhook_url: z.string().url().describe('Webhook to call'),
  api_token: z.string().min(20).max(200).meta({ sensitive: true })
    .describe('Bearer token for the webhook'),
};
```

The audit log applies its own (stricter) redaction independently — sensitive fields never appear in either log stream regardless of this annotation, but the annotation prevents accidental leaks if a field name doesn't match Pino's default redaction paths.

## Optional tool metadata

Beyond `name`/`title`/`description`/`inputSchema`/`handler`, the `ToolDefinition` accepts:

| Field | Type | Purpose |
|--|--|--|
| `outputSchema` | `ZodRawShape` | Declares structured output. When present, the handler MUST populate `structuredContent`. Surfaced to clients as JSON Schema. |
| `rateLimit` | `{ perMinute: number }` | Tighter limit for this tool, applied IN ADDITION to the per-key limit. The stricter of the two wins. |
| `requiresConfirmation` | `boolean` | Hint to clients that this tool performs a destructive/irreversible action. Default `false`. |
| `tags` | `string[]` | Free-form labels for filtering/grouping in dashboards. Not protocol-relevant. |

### `outputSchema` — when to use it

Use it when callers benefit from typed, machine-readable results (e.g., another tool will consume the output, or the client renders it in a UI). Example:

```typescript
const outputSchema = {
  results: z.array(z.object({ id: z.string(), title: z.string(), score: z.number() })),
  total: z.number().int(),
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  // ...
  outputSchema,
  handler: async (input, ctx) => {
    const results = [/* ... */];
    return {
      content: [{ type: 'text', text: `Found ${results.length} matches.` }],
      structuredContent: { results, total: results.length },
    };
  },
};
```

Skip it for tools whose output is naturally narrative text or where clients won't programmatically consume it.

### `rateLimit` — when to use it

Use it for tools that hit external APIs with quotas, are computationally expensive, or perform destructive actions. Example:

```typescript
rateLimit: { perMinute: 10 },  // even if the key allows 60/min, this tool caps at 10/min
```

The per-tool limit is enforced via the same Redis sliding-window mechanism, scoped by `keyId:toolName`.

## Handler rules

### Return shape

Always return a `CallToolResult`:

```typescript
{
  content: [{ type: 'text', text: '...' }],  // required, at least one item
  structuredContent?: { ... },                // required if outputSchema declared
  isError?: false,                            // true to signal error to LLM
}
```

### Error handling

Three categories of error, three different responses:

1. **User input error** (validation already passed but business logic rejects) — return `isError: true` with a helpful message:
   ```typescript
   return { content: [{ type: 'text', text: 'No articles found for that topic.' }], isError: true };
   ```
2. **Transient error** (DB timeout, upstream API down) — `throw` a `TransientError` from `src/lib/errors.ts`. The MCP layer will translate to JSON-RPC `-32013` and the client may retry. See the error hierarchy in `docs/ARCHITECTURE.md`.
3. **Programmer error** (bug, unexpected null) — let it throw. The MCP layer logs and returns a generic internal error. Do not catch and swallow.

### Available context

The `ToolContext` interface is defined formally above. Brief reminder of usage:

- `ctx.logger` — already a child logger with `request_id` and `tool_name` bound. Just call it.
- `ctx.db.query(sql, params)` — parameterized only (`$1`, `$2`).
- `ctx.redis` — for cache and rate-limit-adjacent reads. Do not use it as a queue.
- `ctx.apiKey` — only id, prefix, name, and rate limit. The raw key is never available.
- `ctx.signal` — pass to `fetch(url, { signal: ctx.signal })`, check in long loops. Aborts on client disconnect or shutdown.

### What you must NOT do

- ❌ Import the database pool or Redis client directly. Use `ctx`. (Makes tools untestable.)
- ❌ Read environment variables directly. Use `ctx` or the shared `config` module.
- ❌ Invoke, enqueue, or otherwise drive background workers from a tool. Workers are standalone cron jobs; tools read what workers persist. See `docs/WORKER_AUTHORING.md`.
- ❌ Use `console.log`. Use `ctx.logger`.
- ❌ Store state at module scope (`let cache = ...`). Tools must be stateless.
- ❌ Block the event loop with synchronous I/O or CPU-heavy loops. Surface that work in a scheduled worker and read its output.
- ❌ Make changes that take longer than the tool-call timeout (30s). Either split the work or move it to a scheduled worker.
- ❌ Ignore `ctx.signal`. Long-running work that won't abort holds shutdown hostage.

## Testing requirements

Every tool ships with tests in the same commit. Minimum coverage:

1. **Happy path**: valid input → expected output.
2. **Each error branch**: invalid business state, transient failure, etc.
3. **Schema rejection**: at least one test confirming Zod rejects invalid input. (Usually you can rely on Zod itself, but verify integration.)

Test template:

```typescript
// src/tools/example-tool.test.ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import tool from './example-tool.ts';

describe('example-tool', () => {
  const makeCtx = (overrides = {}) => ({
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
    apiKey: { id: 'test-id', prefix: 'mcp_test', name: 'test' },
    ...overrides,
  });

  it('returns results for a valid query', async () => {
    const ctx = makeCtx({
      db: { query: mock.fn(async () => ({ rows: [{ id: 1, title: 'Hello' }] })) },
    });
    const result = await tool.handler({ query: 'hello', limit: 10 }, ctx);
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Hello/);
  });

  it('returns isError when no results found', async () => {
    const ctx = makeCtx();
    const result = await tool.handler({ query: 'nothing', limit: 10 }, ctx);
    assert.equal(result.isError, true);
  });
});
```

See `docs/TESTING.md` for deeper patterns.

## Tool discovery and load-failure semantics

The loader (`src/shared/tools/loader.ts`) scans `src/tools/` recursively at server startup. Every `.ts` file (excluding `*.test.ts`, `_*.ts`, and the defensive filename set `types.ts` / `loader.ts`) is imported and validated.

**Validation per file:**

1. Default export exists.
2. Default export has the required shape (`name`, `description`, `inputSchema`, `handler`).
3. `name` is unique across all tools.
4. `name` matches `^[a-z][a-z0-9-]*$` (kebab-case, starts with letter).
5. Zod schemas compile without error.

**Failure behavior: fail loudly, always.**

If any tool fails to load — bad import, missing export, malformed schema, name collision — the server **refuses to start**. It logs the offending file and the specific reason, then exits with code 1. This applies in **all environments** including development. There is no skip-and-continue mode and no environment toggle.

Rationale: a missing tool in production is almost always a deploy bug. Silent skipping leads to "the tool exists in code but doesn't work in prod" debugging sessions. Loud failure surfaces the bug at deploy time, before traffic hits the broken state.

When iterating in dev: the `--watch` flag restarts the process, the broken tool stops the restart, and the error is visible in the terminal immediately.

## Common pitfalls

- **Forgetting `.ts` extensions in imports** — Node native type stripping requires explicit extensions.
- **Using `const enum`** — not supported by type stripping. Use `as const` objects.
- **Returning raw objects instead of `CallToolResult`** — the MCP SDK will not coerce; you'll get a runtime error.
- **Putting credentials in tool descriptions** — descriptions are sent to LLMs. Treat them as public.
- **Naming collisions** — tool names are global. The loader will refuse to start the server if two files export the same `name`.
- **Declaring `outputSchema` but not populating `structuredContent`** — runtime error from MCP SDK.
- **Forgetting `.meta({ sensitive: true })` on credential fields** — they'll appear in logs.

## When you need to break a rule

If a tool genuinely needs to be stateful, do long work synchronously, or take a dependency on something not in `ctx`, **stop and ask the user**. There's almost always a better pattern (scheduled worker, shared module, schema change) — but if there isn't, the user will approve and we'll document the exception.
