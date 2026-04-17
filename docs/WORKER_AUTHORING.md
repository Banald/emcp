# Worker authoring guide

This document is the contract for adding scheduled background workers to `src/workers/`. Read it before creating or modifying a worker.

## The drop-in model

A worker is a single `.ts` file in `src/workers/` (or a subdirectory). It exports a `WorkerDefinition` as the default export declaring its own cron schedule. The worker process discovers workers at startup by scanning the directory tree — no manifest, no registry to update. Drop the file in, restart the worker process, the cron is live.

## When to use a worker (vs a tool)

| Use a tool when... | Use a worker when... |
|--|--|
| The client needs a result from this call | The work produces data to read later |
| The work is per-request, per-user | The work runs on a schedule (cron) |
| Failure should fail the request | Failure retries on the next tick |
| Latency matters | Throughput / duration matters |
| Examples: query cached news, call a fast API | Examples: scrape a feed every 6h, nightly digest aggregation |

Tools and workers share Postgres; they do not share runtime objects. A worker writes to a table, a tool reads from it. A tool does not invoke, enqueue, or otherwise drive a worker.

## File layout

```
src/workers/
├── index.ts                  # Worker process entry — DO NOT MODIFY, it is the loader/scheduler bootstrap
├── example.ts                # Reference heartbeat worker (delete if you want an empty slate)
├── example.test.ts
├── fetch-news.ts             # Your worker
├── fetch-news.test.ts
└── digest/                   # Subdirectory grouping for related workers
    ├── compile-daily.ts
    └── compile-daily.test.ts
```

`src/workers/` contains only real worker files plus their colocated tests and the bootstrap `index.ts`. The contract (`WorkerDefinition`, `WorkerContext`), the discovery loader, and the cron scheduler live in `src/shared/workers/`. Worker authors should not modify those.

**Files excluded from discovery** (defensive): `types.ts`, `loader.ts`, `scheduler.ts`, `index.ts`, anything ending in `.test.ts`, anything starting with `_`.

## Naming conventions

- **File name**: `kebab-case.ts` matching the worker name (`fetch-news.ts` → worker name `fetch-news`).
- **Worker name** (`name` field): `kebab-case`, globally unique across all workers. Matches `^[a-z][a-z0-9-]*$`.
- **Description**: One sentence describing what the worker does and how often. Surfaced in logs and metrics.

## The `WorkerDefinition` contract

```typescript
// src/shared/workers/types.ts
import type { Pool } from 'pg';
import type { Logger } from 'pino';

export interface WorkerContext {
  readonly logger: Logger;       // Pino child bound with { worker, run_id }
  readonly db: Pool;
  readonly signal: AbortSignal;  // aborted on shutdown OR per-run timeout
}

export interface WorkerDefinition {
  readonly name: string;
  readonly description?: string;
  readonly schedule: string;        // croner-compatible 5- or 6-field cron
  readonly timezone?: string;       // IANA zone; defaults to UTC
  readonly runOnStartup?: boolean;  // fire once at startup alongside the cron; does not block start()
  readonly timeoutMs?: number;      // per-run timeout; default 5 minutes
  readonly handler: (ctx: WorkerContext) => Promise<void>;
}
```

`WorkerContext` deliberately has no Redis and no queue handles. A cron worker reads/writes Postgres and nothing else. If a future use case needs caching in a worker, add it back with deliberation — don't thread it in just because the server has it.

## Authoring template

```typescript
// src/workers/fetch-news.ts
import type { WorkerDefinition } from '../shared/workers/types.ts';

const worker: WorkerDefinition = {
  name: 'fetch-news',
  description: 'Pulls the hourly feed from example.com/news and upserts rows into articles.',
  schedule: '0 * * * *',             // top of every hour
  timezone: 'UTC',                    // optional
  runOnStartup: false,                // do not fire immediately on boot
  timeoutMs: 2 * 60_000,              // 2 minutes per run
  handler: async (ctx) => {
    ctx.logger.info('fetch-news starting');

    const response = await fetch('https://example.com/news.json', {
      signal: ctx.signal,             // honor shutdown and per-run timeout
    });
    if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
    const articles = (await response.json()) as Array<{ id: string; title: string; url: string }>;

    for (const a of articles) {
      if (ctx.signal.aborted) break;  // bail early on shutdown
      await ctx.db.query(
        `INSERT INTO articles (id, title, url)
         VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url`,
        [a.id, a.title, a.url],
      );
    }

    ctx.logger.info({ count: articles.length }, 'fetch-news done');
  },
};

export default worker;
```

## Cron syntax

Schedules use [croner](https://github.com/hexagon/croner), which accepts the familiar 5-field (`min hour dom mon dow`) or 6-field (with seconds) cron. Examples:

| Schedule | Meaning |
|--|--|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour on the hour |
| `0 */6 * * *` | Every 6 hours |
| `0 3 * * *` | 03:00 daily |
| `0 0 * * 1` | 00:00 Mondays |

Set `timezone` to an IANA zone (e.g. `'Europe/Stockholm'`) if the schedule is wall-clock sensitive (payroll, business-hours jobs). Omit it (UTC) for internal batch work to avoid DST surprises.

## Overlap protection

The scheduler guarantees **at most one concurrent run per worker definition**. If a new tick arrives while the previous run is still in flight, the scheduler logs `worker_fire_skipped`, increments `worker_runs_total{status="skipped_overlap"}`, and drops the new tick. Handlers do not need their own in-file locking.

If a handler takes longer than its cron interval, you will see skips — either tighten the handler or loosen the schedule.

## Honoring `ctx.signal`

`ctx.signal` aborts when:

- The process receives SIGTERM/SIGINT (graceful shutdown) — the abort controller shared by the scheduler fires.
- The per-run `timeoutMs` elapses — the scheduler aborts this run's signal independently.

Minimum viable cooperation:

- Pass `signal: ctx.signal` to `fetch()`, `pool.query({ text, values, ... })` (via an AbortController chained to ctx.signal), and any other async I/O that accepts a signal.
- In long loops, check `ctx.signal.aborted` at a natural boundary and break.

A handler that ignores the signal is not wrong per se — the scheduler will move on and mark the run as `timeout` — but the abandoned promise leaks resources until it finally settles (if ever).

## Error handling

Throw to abort a run. The scheduler catches the throw, records `worker_runs_total{status="failure"}`, logs `worker_run_failure` with the error, and moves on. **The next cron tick still fires** — there is no retry plumbing in the definition. If you want immediate retries within a single run, own them inside the handler (e.g., retry-with-backoff around a flaky upstream). If you want a different cadence for retries, don't use cron retries — encode it in the schedule.

## Running and observing

- Dev: `npm run dev:worker` runs `node --env-file=.env --watch src/workers/index.ts`. Logs are pretty-printed when `NODE_ENV=development`.
- Prod: the `mcp-worker` service in `compose.yaml` runs `node dist/workers/index.js` (one container). Bare-metal fallback: `npm run start:worker` plus PM2 config (`ecosystem.config.cjs`) that pins a single instance. See "Known limitations" below for why there is only one instance.
- Metrics (Prometheus, scraped from the server's `/metrics`):
  - `worker_runs_total{worker, status}` — labels: `success`, `failure`, `timeout`, `skipped_overlap`.
  - `worker_run_duration_seconds{worker}` — histogram.
- Log events emitted per run: `worker_scheduled`, `worker_run_start`, `worker_run_success`, `worker_run_failure`, `worker_run_timeout`, `worker_fire_skipped`, `worker_stopped`. Every run log carries `run_id` for correlation.

## Shutdown

On SIGTERM:

1. The scheduler stops all cron handles (no new ticks).
2. The shutdown abort controller fires — in-flight handlers receive the abort via `ctx.signal`.
3. The scheduler waits up to `SHUTDOWN_TIMEOUT_MS` (default 30s) for in-flight runs to settle.
4. The Postgres pool closes.
5. Process exits 0.

If a handler wedges past the grace window, the process exits anyway. The supervisor's grace window — Docker Compose `stop_grace_period: 65s` or PM2 `kill_timeout: 65000` — gives margin over the default 30s.

## Testing workers

Unit-test the handler directly. Use a fake `WorkerContext`. Integration coverage of discovery + scheduling is already provided by `tests/integration/worker.test.ts`.

```typescript
// src/workers/fetch-news.test.ts
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { createLogger } from '../lib/logger.ts';
import type { WorkerContext } from '../shared/workers/types.ts';
import worker from './fetch-news.ts';

describe('fetch-news worker', () => {
  it('has the expected identity and valid cron', () => {
    assert.equal(worker.name, 'fetch-news');
    assert.match(worker.schedule, /^\S+ \S+ \S+ \S+ \S+$/);
  });

  it('inserts each article', async () => {
    const query = mock.fn(async () => ({ rows: [] }));
    const ctx = {
      logger: createLogger({ level: 'silent' }).child({}),
      db: { query } as unknown as WorkerContext['db'],
      signal: new AbortController().signal,
    } satisfies WorkerContext;

    // …stub global fetch, then:
    await worker.handler(ctx);
    assert.ok(query.mock.callCount() > 0);
  });
});
```

## Known limitations

- **One worker process only.** Both `compose.yaml` (implicit `deploy.replicas: 1`) and `ecosystem.config.cjs` (`instances: 1`) pin `mcp-worker` to a single instance because croner schedules in-memory and multiple processes would double-fire every tick. Horizontal scaling requires a Redis advisory lock around each fire (`SET key NX EX ttl`) — an explicit follow-up item, not shipped in this refactor.
- **No persistent job queue.** If the worker is down when a tick should fire, the tick is missed. This is intentional — cron workers are for recurring background refresh, not at-least-once delivery. If you need delivery guarantees, use a different pattern (outbox, external queue) and justify the complexity.

## Common pitfalls

- **Non-idempotent handlers.** Workers may be aborted mid-run; next tick will run again. Use upserts, idempotent writes, or mark-processed patterns.
- **Ignoring `ctx.signal`.** Long handlers that don't abort block shutdown up to the grace window and can leak resources past it.
- **Cron that fires faster than the handler can complete.** You'll see `skipped_overlap`. Either slow the schedule or speed up the handler.
- **Reaching for module-scope state.** Workers run in the same process; a mutable at module scope is shared across every run. Prefer per-run locals.
- **Importing Redis or network clients into `WorkerContext`.** If you genuinely need them, add them to the contract in `src/shared/workers/types.ts` — don't import the global singleton from a handler.

## When you need to break a rule

If a worker genuinely needs at-least-once delivery, exclusive locks across processes, or hour-long runs — **stop and ask the user**. There's probably a better shape (outbox, external scheduler, splitting the handler), but if there isn't, we'll approve and document the exception.
