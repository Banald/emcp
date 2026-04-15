# Architecture

This document explains **why** the system is built the way it is. Read this before making structural decisions or proposing dependency changes.

## System overview

```
┌────────────────┐         HTTPS          ┌──────────────────────────────┐
│  MCP Clients   │ ─────────────────────▶ │   Reverse Proxy (nginx)      │
│ (Claude, IDEs) │  Authorization: Bearer │   - TLS termination          │
└────────────────┘                         │   - Forwards to MCP server   │
                                           └──────────────┬───────────────┘
                                                          │ HTTP (loopback)
                                                          ▼
                                           ┌──────────────────────────────┐
                                           │   MCP Server (Node.js)       │
                                           │   - Streamable HTTP /mcp     │
                                           │   - Auth middleware          │
                                           │   - Rate limiting            │
                                           │   - Tool dispatch            │
                                           │   - Metrics collection       │
                                           └──────┬───────────────┬───────┘
                                                  │               │
                                          enqueue │               │ query
                                                  ▼               ▼
                                           ┌──────────┐    ┌──────────────┐
                                           │  Redis   │◀───│  PostgreSQL  │
                                           │ (BullMQ, │    │ (API keys,   │
                                           │  cache,  │    │  metrics,    │
                                           │  rate    │    │  tool data)  │
                                           │  limit)  │    └──────────────┘
                                           └────┬─────┘
                                                │ pop jobs
                                                ▼
                                           ┌──────────────────────────────┐
                                           │   Worker Process (PM2)       │
                                           │   - BullMQ Worker            │
                                           │   - Background jobs          │
                                           └──────────────────────────────┘
```

The MCP server and worker are **separate processes** managed by PM2. They communicate exclusively through Redis (job queue) and Postgres (shared state). This isolation means a misbehaving worker cannot block the HTTP server's event loop, and either can be scaled or restarted independently.

## Major decisions and rationale

### MCP transport: Streamable HTTP (not the old HTTP+SSE)

The MCP spec deprecated the dual-endpoint HTTP+SSE transport in 2025-03-26. Streamable HTTP uses a **single endpoint** (`/mcp`) handling both POST (client→server JSON-RPC) and optionally GET (server→client SSE stream for notifications). Session continuity is via the `Mcp-Session-Id` header. We use the official `StreamableHTTPServerTransport` from the SDK — do not hand-roll the protocol.

**Stateful mode** is used so server-initiated messages (progress, logging) reach clients via the open SSE stream. Stateless mode would limit us to request-response only.

### Runtime: Node.js 24 LTS (not Bun, not Deno)

Bun is faster but has imperfect compatibility with the MCP SDK and BullMQ's full feature set. Deno's npm interop is improving but introduces friction. Node.js 24 gives us:

- **Native TypeScript execution** — no `tsx`/`ts-node` needed in dev. Run `node src/index.ts` directly.
- **Native `--env-file`** — no `dotenv` package needed.
- **Native `node:test`** — no jest/vitest needed.
- Tier-1 support from every dependency we use.

We use `bun install` as the package manager (much faster than npm/yarn) but `node` as the runtime. This is a deliberate hybrid.

### TypeScript configuration

`erasableSyntaxOnly: true` is required for Node.js native type stripping — it forbids `const enum`, `namespace`, parameter properties, and other non-erasable constructs. `verbatimModuleSyntax: true` requires explicit `import type`. These are not optional; the runtime depends on them.

Path aliases (`@/lib/...`) **do not work** with native type stripping because Node.js doesn't read `tsconfig.json` at runtime. Use relative imports.

### Database: PostgreSQL via `pg` (not Prisma, not Drizzle, not postgres.js)

- **`pg`**: 20M+ weekly downloads, 10+ year track record, built-in pooling, universal compatibility. Performance difference vs `postgres.js` is negligible (~200µs vs ~180µs per query).
- **No ORM**: Prisma adds a massive dependency tree and code generation step. Drizzle is lighter but still adds friction. For a server with a small, well-defined schema, raw SQL with `pg` is simpler, faster, and has zero abstraction surprises.
- **Migrations: `node-pg-migrate`** with raw SQL files. Only 2 transitive deps, uses `pg` as a peer.

### Cache and queue: Redis via `ioredis` (not `node-redis`)

`ioredis` is **required by BullMQ** — non-negotiable. It also provides better cluster/sentinel support and automatic reconnection than `node-redis`. We use the same Redis instance for BullMQ, rate limiting, and ad-hoc caching, but with **separate connections** for each (BullMQ workers need `maxRetriesPerRequest: null`; everything else uses sensible defaults).

### Background jobs: BullMQ

Mature, actively developed (weekly releases), TypeScript-native. Supports repeatable (cron) jobs, retries with backoff, dead letter queues, job priorities, and rate limiting. Workers run in a **separate process** (managed by PM2) so they don't share an event loop with the HTTP server.

**Critical Redis configuration**: `maxmemory-policy noeviction`. Any other policy silently corrupts BullMQ data. This is the #1 production incident with BullMQ.

### Validation: Zod 4

Zod 4 has **native `z.toJSONSchema()`** support — we don't need the deprecated `zod-to-json-schema` package. The MCP SDK also internally converts Zod schemas to JSON Schema for tool registration, so tool authors write Zod and get JSON Schema for free.

### Logging: Pino

Pino is ~5× faster than Winston, has built-in field redaction (critical for our security posture — see `docs/SECURITY.md`), supports child loggers for context propagation, and can offload formatting to a worker thread. We use `pino-pretty` as a dev dependency only; production logs are JSON.

### Metrics: prom-client

De facto standard for Prometheus metrics in Node.js. Zero production dependencies. Exposes `/metrics` for scraping. We collect: request rate per tool, request duration histogram, API key request count, error rate, queue depth, worker job duration.

### Testing: node:test + c8

`node:test` is stable, builtin, and feature-complete (describe/it, hooks, mocks, snapshots, watch, parallel). `c8` wraps V8's native coverage — it has the `--all` flag (essential, reports 0% for untested files) and threshold enforcement (`--lines 95`). Node's built-in `--experimental-test-coverage` lacks both.

### Linting: Biome (not ESLint + Prettier)

Single zero-dependency binary. 10-25× faster than ESLint+Prettier. v2 supports type-aware rules. Eliminates an entire dependency tree.

## Approved production dependencies

This list is the source of truth. Adding to it requires explicit user approval per `AGENTS.md`.

| Package | Purpose | Why this one |
|--|--|--|
| `@modelcontextprotocol/sdk` | MCP protocol implementation | Official, only viable choice |
| `zod` | Input validation, JSON Schema generation | Required by SDK; v4 has native JSON Schema |
| `pg` | PostgreSQL client | Universal standard, minimal deps |
| `ioredis` | Redis client | Required by BullMQ |
| `bullmq` | Background job queue | Mature, TypeScript-native |
| `pino` | Structured logging | Fast, redaction-aware |
| `prom-client` | Prometheus metrics | Zero deps, de facto standard |
| `node-pg-migrate` | Database migrations | Minimal deps, raw SQL files |

## Approved dev dependencies

| Package | Purpose |
|--|--|
| `typescript` | Type checking and production build |
| `@types/node` | Node.js type definitions |
| `@types/pg` | pg type definitions |
| `@biomejs/biome` | Lint + format |
| `c8` | Test coverage with thresholds |
| `pino-pretty` | Human-readable dev logs |
| `testcontainers` | Postgres/Redis for integration tests |
| `@testcontainers/postgresql` | Postgres testcontainer helper |

## Explicitly rejected

- **Express, Fastify, Hono, Koa**: Use raw `node:http`. The MCP transport handles routing for the `/mcp` endpoint; we only need a thin wrapper for `/health`, `/metrics`, and Origin validation.
- **dotenv**: Replaced by `node --env-file=.env`.
- **tsx, ts-node**: Replaced by Node.js native type stripping.
- **jest, vitest, mocha, chai, sinon**: Replaced by `node:test`.
- **eslint, prettier, typescript-eslint**: Replaced by Biome.
- **winston, bunyan**: Pino is faster and safer.
- **node-redis**: Incompatible with BullMQ.
- **prisma, drizzle, knex, typeorm**: Raw SQL with `pg` is sufficient for this scope.
- **zod-to-json-schema**: Deprecated; Zod 4 has native support.
- **bcrypt, argon2 for API keys**: Wrong tool — see `docs/SECURITY.md`.

## Version pinning

| Concern | Policy |
|--|--|
| Node.js runtime | **Exact major: Node.js 24 LTS.** Pinned via `.nvmrc` (`24`) and `engines.node` in `package.json` (`>=24.0.0 <25.0.0`). CI uses the same. |
| `@modelcontextprotocol/sdk` | **Tilde range: `~1.26.0`.** Patch updates only. Minor SDK updates can ship behavioral changes; bump deliberately and re-test. Migration to v2 is a deliberate project, not an automatic update. |
| Other production deps | **Caret range: `^x.y.z`.** Standard semver. Lockfile pins exact versions. |
| Dev deps | **Caret range.** Same policy. |
| Lockfile | Always committed. CI uses `npm ci` (or `bun install --frozen-lockfile`) — never `npm install`. |

## Database schema (baseline)

This is the schema as of the initial build. All future changes go through migrations in `migrations/` (see `docs/OPERATIONS.md`).

```sql
-- API keys: one row per key, never hard-deleted
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix      VARCHAR(20)  NOT NULL,           -- e.g. 'mcp_live_k7Hj9mNq' (first 12+ chars, for identification)
  key_hash        VARCHAR(64)  NOT NULL UNIQUE,    -- HMAC-SHA256(pepper, raw_key)
  name            VARCHAR(255) NOT NULL,           -- human label for the key
  status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'blacklisted', 'deleted')),
  rate_limit_per_minute INT    NOT NULL DEFAULT 60,
  allow_no_origin BOOLEAN      NOT NULL DEFAULT FALSE,  -- permit requests without Origin header
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  blacklisted_at  TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  -- Aggregate metrics (updated asynchronously per request)
  request_count    BIGINT NOT NULL DEFAULT 0,
  bytes_in         BIGINT NOT NULL DEFAULT 0,
  bytes_out        BIGINT NOT NULL DEFAULT 0,
  total_compute_ms BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_api_keys_status ON api_keys(status) WHERE status = 'active';
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- Per-tool usage breakdown
CREATE TABLE api_key_tool_usage (
  key_id           UUID         NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  tool_name        VARCHAR(255) NOT NULL,
  invocation_count BIGINT       NOT NULL DEFAULT 0,
  total_compute_ms BIGINT       NOT NULL DEFAULT 0,
  bytes_in         BIGINT       NOT NULL DEFAULT 0,
  bytes_out        BIGINT       NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  PRIMARY KEY (key_id, tool_name)
);

-- Migration tracking (managed by node-pg-migrate, schema may differ slightly)
CREATE TABLE pgmigrations (
  id     SERIAL PRIMARY KEY,
  name   VARCHAR(255) NOT NULL,
  run_on TIMESTAMP    NOT NULL
);
```

**Note**: `api_keys` rows are **never hard-deleted**. Soft-delete sets `status = 'deleted'` and `deleted_at = now()` to preserve historical metrics. The `ON DELETE RESTRICT` on `api_key_tool_usage.key_id` enforces this at the DB level.

Application-specific tool data tables (e.g., a `news_articles` table for the example fetch-news tool) live alongside but are added via migrations as features are built.

## Configuration: environment variables

All configuration lives in environment variables, parsed and validated by Zod at startup in `src/config.ts`. Missing or invalid required vars cause **immediate startup failure** with a clear error.

| Variable | Required | Example | Purpose |
|--|--|--|--|
| `NODE_ENV` | yes | `production` | `development` \| `production` \| `test` |
| `PORT` | yes | `3000` | HTTP port for MCP server (bind to loopback) |
| `BIND_HOST` | no | `127.0.0.1` | Interface to bind. Default `127.0.0.1`. Never `0.0.0.0` in production. |
| `PUBLIC_HOST` | yes | `mcp.example.com` | Expected `Host` header value (DNS rebinding defense) |
| `ALLOWED_ORIGINS` | yes | `https://app.example.com,https://...` | Comma-separated allowlist for `Origin` header |
| `DATABASE_URL` | yes | `postgres://user:pass@localhost:5432/mcp` | Postgres connection string |
| `DATABASE_POOL_MAX` | no | `20` | Max pool connections. Default 10. |
| `REDIS_URL` | yes | `redis://localhost:6379` | Redis connection string |
| `API_KEY_HMAC_SECRET` | yes | (32+ random bytes, base64) | HMAC pepper for API key hashing. **Rotating this invalidates ALL keys.** |
| `LOG_LEVEL` | no | `info` | Pino level. Default `info` in prod, `debug` in dev. |
| `RATE_LIMIT_DEFAULT_PER_MINUTE` | no | `60` | Fallback when key has no override. Default 60. |
| `WORKER_CONCURRENCY` | no | `3` | Default per-queue concurrency. Default 3. |
| `SHUTDOWN_TIMEOUT_MS` | no | `30000` | Server graceful shutdown deadline. Default 30s (server) / 60s (worker). |

Maintain `.env.example` in the repo with all variables, placeholder values, and inline comments. `.env` itself is git-ignored.

## Error hierarchy

All errors thrown by application code descend from `AppError` in `src/lib/errors.ts`. The HTTP/MCP layer maps them to JSON-RPC error codes and HTTP status codes consistently.

| Class | HTTP | JSON-RPC code | Retryable | When to throw |
|--|--|--|--|--|
| `AppError` (base) | 500 | -32603 | no | Don't throw directly — extend it |
| `ValidationError` | 400 | -32602 | no | Input passed Zod but failed business validation |
| `AuthError` | 401 | -32001..-32003 | no | Missing/malformed/unknown credentials |
| `KeyBlacklistedError` | 403 | -32004 | no | Authenticated key is blacklisted |
| `KeyDeletedError` | 403 | -32005 | no | Authenticated key is soft-deleted |
| `RateLimitError` | 429 | -32029 | yes (after `Retry-After`) | Rate limit exceeded |
| `NotFoundError` | 404 | -32011 | no | Resource lookup returned nothing |
| `ConflictError` | 409 | -32012 | no | Unique constraint, version mismatch, etc. |
| `TransientError` | 503 | -32013 | yes | Upstream timeout, DB connection blip — client may retry |
| `ConfigError` | n/a | n/a | no | Thrown only at startup; halts the process |

Generic `Error` and uncaught throws map to HTTP 500 / JSON-RPC -32603 with a generic message. The actual error is logged with full stack trace; the client sees no internals.

## Endpoints

| Path | Method | Purpose | Auth |
|--|--|--|--|
| `/mcp` | POST | MCP JSON-RPC over Streamable HTTP | API key required |
| `/mcp` | GET | Optional server→client SSE stream (notifications) | API key required |
| `/mcp` | DELETE | Terminate session (Streamable HTTP) | API key required |
| `/health` | GET | Liveness + readiness probe | none (binds loopback only) |
| `/metrics` | GET | Prometheus metrics scrape endpoint | none (binds loopback only) |

`/health` returns JSON: `{ "status": "ok", "checks": { "db": "ok", "redis": "ok" }, "uptime_s": 123 }`. Returns HTTP 503 if any dependency check fails. `/metrics` returns Prometheus text format.

Both `/health` and `/metrics` are unauthenticated because the process binds to `127.0.0.1` only — they're inaccessible externally. The reverse proxy must NOT forward these paths to the internet.

## Process model

| Process | Count | Purpose |
|--|--|--|
| `mcp-server` | 1 | HTTP server, MCP transport, auth, tool dispatch |
| `mcp-worker` | 2+ | BullMQ workers, scaled independently |

Managed by PM2 in production. Both processes share the same codebase and the same Postgres/Redis. Graceful shutdown drains in-flight requests/jobs with a 30s/60s timeout respectively.

## Data flow: a tool call

1. Client sends `POST /mcp` with `Authorization: Bearer mcp_live_...` and JSON-RPC `tools/call`.
2. HTTP layer validates `Origin` and `Host` headers (DNS rebinding defense).
3. Auth middleware extracts the bearer token, HMAC-hashes it, looks it up in Postgres.
4. If blacklisted/deleted/missing: return JSON-RPC error with appropriate code.
5. Rate limiter checks Redis sliding window for this key. If exceeded: return 429.
6. MCP transport dispatches to the named tool handler.
7. Tool handler executes, optionally enqueues BullMQ jobs, optionally queries Postgres/Redis.
8. Response sent back; metrics (request count, bytes, compute time) updated in Postgres asynchronously to avoid blocking the response.

## Data flow: a background job

1. Tool handler (or scheduled trigger) calls `queue.add('job-name', payload, opts)`.
2. BullMQ pushes job to Redis.
3. Worker process pops the job (blocking pop via ioredis), executes the processor function.
4. Processor reads/writes Postgres, calls external APIs, etc.
5. On failure: BullMQ retries with exponential backoff (configured per queue). After max retries: job moves to failed state for inspection.
6. On success: job moves to completed state, result optionally available for inspection.

Repeatable jobs (cron-like) are configured at queue setup with `repeat: { cron: '...' }`.
