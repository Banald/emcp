# Testing

This document covers test framework, patterns, and the coverage gate. Read it before writing tests or modifying the CI config.

## Framework: `node:test` + `c8`

We use Node.js's built-in test runner. **Do not introduce vitest, jest, mocha, or any other framework.** `node:test` is stable, fast, and adds zero dependencies.

Coverage is via `c8` (V8 native coverage with threshold enforcement). Node's built-in `--experimental-test-coverage` lacks the `--all` flag and threshold gates, so we use `c8`.

## Coverage gate

| Metric | Threshold |
|--|--|
| Lines | 95% |
| Functions | 95% |
| Branches | 90% |

CI fails if any metric drops below threshold. Do not weaken thresholds to make a build pass — write the missing tests, or refactor to make the code testable.

The `--all` flag is mandatory: it reports 0% for files that have no tests at all, preventing the "100% coverage of the 1 file with tests" deception.

## Test types and where they live

| Type | Location | Runs in |
|--|--|--|
| Unit | Co-located: `foo.ts` + `foo.test.ts` | Always — fast, no infrastructure |
| Integration | `tests/integration/*.test.ts` | CI and local with Docker |
| E2E (full MCP client→server) | `tests/integration/mcp-transport.test.ts` | CI |

Unit tests **must** be runnable without Docker, network, or any external services. Integration tests use Testcontainers (real Postgres + Redis in disposable containers).

## Running tests

```bash
# All unit tests, no coverage
node --test --import ./tests/setup.ts 'src/**/*.test.ts'

# All tests with coverage and threshold enforcement
c8 --config .c8rc.json node --test --import ./tests/setup.ts 'src/**/*.test.ts'

# Watch mode
node --test --import ./tests/setup.ts --watch 'src/**/*.test.ts'

# Single file
node --test --import ./tests/setup.ts src/tools/whoami.test.ts

# Filter by name
node --test --import ./tests/setup.ts --test-name-pattern='returns key info' 'src/**/*.test.ts'
```

## Unit test patterns

### Basic structure

```typescript
import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { thingUnderTest } from './thing-under-test.ts';

describe('thingUnderTest', () => {
  beforeEach(() => {
    mock.reset();
  });

  it('does the thing', () => {
    assert.equal(thingUnderTest(2, 2), 4);
  });

  it('throws on invalid input', () => {
    assert.throws(() => thingUnderTest(-1, 0), /invalid/);
  });
});
```

Use `node:assert/strict` (not `assert`). It enables strict equality by default and prevents subtle `==` bugs.

### Async tests

```typescript
it('resolves with the right value', async () => {
  const result = await asyncThing();
  assert.equal(result, 'expected');
});

it('rejects with a typed error', async () => {
  await assert.rejects(
    () => asyncThing('bad'),
    (err: Error) => err.message.includes('expected message'),
  );
});
```

### Mocking

`node:test` has a built-in `mock` API. No `sinon` needed.

```typescript
import { mock } from 'node:test';

it('calls the dependency once', async () => {
  const fakeDb = { query: mock.fn(async () => ({ rows: [] })) };
  await thingThatUsesDb(fakeDb);
  assert.equal(fakeDb.query.mock.callCount(), 1);
  assert.deepEqual(fakeDb.query.mock.calls[0].arguments, ['SELECT * FROM x']);
});
```

For mocking modules (rare — prefer dependency injection):

```typescript
import { mock } from 'node:test';

mock.module('./external.ts', {
  namedExports: { fetchData: mock.fn(async () => 'mocked') },
});
```

## Patterns by component

### Tool handlers

Tools take `ctx` as a parameter — that's your seam. Build a fake `ctx`, call the handler, assert.

```typescript
const makeCtx = (overrides = {}) => ({
  logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn(), child: () => makeCtx().logger },
  db: { query: mock.fn(async () => ({ rows: [] })) },
  redis: { get: mock.fn(async () => null), set: mock.fn(async () => 'OK') },
  apiKey: { id: 'test', prefix: 'mcp_test', name: 'test' },
  ...overrides,
});
```

Cover: happy path, each error branch, schema-rejected inputs (rare — Zod handles most, but verify integration).

### Scheduled workers

A worker is a default-exported `WorkerDefinition`. Unit-test the `handler` directly with a fake `WorkerContext`:

```typescript
import type { WorkerContext } from '../shared/workers/types.ts';

const ctx = {
  logger: createLogger({ level: 'silent' }).child({}),
  db: { query: mock.fn(async () => ({ rows: [] })) } as unknown as WorkerContext['db'],
  signal: new AbortController().signal,
} satisfies WorkerContext;

await worker.handler(ctx);
```

Also assert the identity fields — `name`, a parseable `schedule` (instantiate `new Cron(worker.schedule, { paused: true })` once as a sanity check). The scheduler itself is covered by `src/shared/workers/scheduler.test.ts`; worker authors do not need to re-prove overlap/timeout behavior.

### Auth middleware

Build fake `IncomingMessage` and `ServerResponse` objects. Cover:

- Valid key → request proceeds, ctx populated.
- Missing header → 401.
- Malformed bearer → 401.
- Unknown key → 401.
- Blacklisted key → 403 with correct error code.
- Soft-deleted key → 403 with correct error code.
- Invalid Origin → 403 (rejected before key lookup).
- Rate-limited → 429.

### Repositories (Postgres)

For unit tests, mock the `pg.Pool` (its `query` method is the only thing that matters). For integration tests, use the real DB via Testcontainers.

```typescript
// Unit
const pool = { query: mock.fn(async () => ({ rows: [{ id: '1' }], rowCount: 1 })) };
const repo = new ApiKeyRepository(pool as any);
const result = await repo.findById('1');
assert.equal(result.id, '1');
```

### HTTP/transport layer

Use the MCP SDK's `Client` to talk to your running server in-process:

```typescript
// tests/integration/mcp-transport.test.ts
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startTestServer } from './_helpers/server.ts';

describe('MCP transport', () => {
  let server: { url: string; close: () => Promise<void> };
  let client: Client;

  before(async () => {
    server = await startTestServer();
    client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${server.testApiKey}` } },
    }));
  });

  after(async () => {
    await client.close();
    await server.close();
  });

  it('lists tools', async () => {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
  });

  it('calls a tool', async () => {
    const result = await client.callTool({ name: 'fetch-news', arguments: { topic: 'tech' } });
    assert.equal(result.isError, undefined);
  });
});
```

## Integration testing with Testcontainers

Integration tests spin up real Postgres and Redis in containers, run migrations, exercise the full stack, then tear down.

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer } from 'testcontainers';

let pgContainer: StartedPostgreSqlContainer;
let redisContainer: StartedTestContainer;

before(async () => {
  pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  process.env.DATABASE_URL = pgContainer.getConnectionUri();
  process.env.REDIS_URL = `redis://localhost:${redisContainer.getMappedPort(6379)}`;

  await runMigrations();
});

after(async () => {
  await pgContainer.stop();
  await redisContainer.stop();
});
```

Redis has no special configuration requirements — it's only used for the rate-limit sliding window and ad-hoc caching. The worker process does not touch Redis at all.

## Coverage exclusions

Some files are inherently untestable in unit tests and excluded from coverage:

- `src/index.ts` — bootstrap entry point (covered by integration tests).
- `src/workers/index.ts` — worker process bootstrap (logic lives in `src/shared/workers/` and is unit-tested there).
- `src/db/migrate.ts` — migration runner (covered by integration setup).
- Anything in `migrations/` (raw SQL).

`.c8rc.json`:

```json
{
  "all": true,
  "include": ["src/**/*.ts"],
  "exclude": [
    "**/*.test.ts",
    "src/index.ts",
    "src/workers/index.ts",
    "src/db/migrate.ts",
    "src/**/types.ts"
  ],
  "reporter": ["text", "lcov", "html"],
  "report-dir": "coverage",
  "lines": 95,
  "functions": 95,
  "branches": 90
}
```

Adding a file to the exclusion list requires a comment in the PR explaining why and is reviewed skeptically.

## CI integration

The GitHub Actions workflow runs (in order):

1. `biome check` (lint + format)
2. `tsc --noEmit` (typecheck)
3. `c8 ... node --test 'src/**/*.test.ts'` (unit + coverage gate)
4. Integration tests in a separate job with service containers for Postgres + Redis

A failure at any step fails the build. There is no `--passWithNoTests` equivalent that lets us slip.

## Common pitfalls

- **Forgetting `mock.reset()` between tests** — leaks call counts across tests, hiding bugs.
- **Asserting on log output** — fragile. Assert on behavior, not on `logger.info` calls (unless the log itself is the contract).
- **Shared state between tests** — top-level `let`s in test files are a smell. Use `beforeEach` to reset.
- **Hitting real Redis/Postgres in unit tests** — slow, flaky. Use mocks for unit; Testcontainers for integration.
- **Time-based flakiness** — `Date.now()`, `setTimeout`, etc. Use `mock.timers.enable()` from `node:test`.
- **Network in unit tests** — never. If the code under test makes HTTP calls, inject a fetcher.

## When tests are hard to write

That's a code smell, not a testing problem. If a function is hard to test, it's usually because:

- It does too much (split it).
- It reaches into globals (inject the dependency).
- It has hidden side effects (make them explicit and return them).
- It's deeply coupled to infrastructure (extract pure logic).

Refactor the production code, then write the test. Don't reach for elaborate mocking machinery to compensate for an untestable design.
