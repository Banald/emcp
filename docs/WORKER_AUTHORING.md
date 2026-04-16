# Worker authoring guide

This document is the contract for adding background workers to `src/workers/`. Read it before creating or modifying a worker.

## When to use a worker (vs a tool)

| Use a tool when... | Use a worker when... |
|--|--|
| The work completes in <5 seconds | The work takes >5 seconds |
| The client needs the result immediately | The result can be retrieved later |
| The work is per-request | The work is scheduled (cron) or batch |
| Failure means failing the request | Failure should retry automatically |
| Examples: query DB, call fast API | Examples: scrape news site, send batch email, generate report |

A common pattern: a tool enqueues a worker job and returns a job ID; another tool queries job status by ID.

## File layout

```
src/workers/
├── index.ts                          # Worker process entry — instantiates all Worker objects
├── queues.ts                         # Shared Queue definitions (imported by tools and workers)
├── _connection.ts                    # Shared ioredis connection factory for workers
├── processors/                       # Pure processor functions (testable in isolation)
│   ├── fetch-news.ts
│   ├── fetch-news.test.ts
│   ├── send-digest.ts
│   └── send-digest.test.ts
└── schedules.ts                      # Repeatable job registration (cron-like)
```

The split between `processors/` (pure logic) and `index.ts` (BullMQ wiring) is critical for testability. Processors are plain async functions you can unit-test without spinning up Redis. The Worker objects in `index.ts` are thin wrappers.

## Defining a queue

Queues are defined once in `src/workers/queues.ts` and imported by both producers (tools, schedules) and consumers (workers). This guarantees the queue name is consistent.

```typescript
// src/workers/queues.ts
import { Queue } from 'bullmq';
import { producerConnection } from './_connection.ts';

export const newsQueue = new Queue<NewsJobData>('news', {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 86400, count: 1000 },  // keep 1 day or 1000 jobs
    removeOnFail: { age: 604800 },                   // keep failures 7 days for inspection
  },
});

export interface NewsJobData {
  url: string;
  topic: string;
}
```

**Always type the job data**. `Queue<TData>` propagates the type to producers and consumers — you'll catch payload mismatches at compile time.

## Writing a processor

Processors are pure async functions. They take a `Job` and a `ctx` (`WorkerContext` provides `logger`, `db`, and `redis` — the subset of `ToolContext` relevant to background processing) and do the work.

```typescript
// src/workers/processors/fetch-news.ts
import type { Job } from 'bullmq';
import type { WorkerContext } from '../types.ts';
import type { NewsJobData } from '../queues.ts';

export async function fetchNewsProcessor(
  job: Job<NewsJobData>,
  ctx: WorkerContext,
): Promise<{ articlesFetched: number }> {
  const { url, topic } = job.data;
  ctx.logger.info({ jobId: job.id, url, topic }, 'fetching news');

  // Update progress for observability
  await job.updateProgress(10);

  // ... do the work ...
  const articles = await fetchAndParse(url);
  await job.updateProgress(50);

  await ctx.db.query(
    'INSERT INTO articles (topic, title, url) VALUES ($1, $2, $3)',
    [topic, articles[0].title, articles[0].url],
  );

  await job.updateProgress(100);
  return { articlesFetched: articles.length };
}
```

**Processor rules:**

- Return a serializable value (string, number, plain object). It's stored in Redis and surfaced via `job.returnvalue`.
- Throw on failure. BullMQ handles retries automatically per the queue's `attempts` and `backoff` config.
- Use `job.updateProgress()` for long jobs — visible in dashboards and useful for status APIs.
- Never reach into the global registry — take `ctx` as a parameter, like tool handlers.
- Keep processors **idempotent**. Workers may retry; partial side effects must be safe to repeat.

## Wiring a worker

`src/workers/index.ts` instantiates `Worker` objects and ties processors to queues. Context is constructed inline — there's no factory function because the worker process has a single, stable set of dependencies for its lifetime.

```typescript
// src/workers/index.ts
import { Worker } from 'bullmq';
import { workerConnection } from './_connection.ts';
import { fetchNewsProcessor } from './processors/fetch-news.ts';
import { logger } from '../lib/logger.ts';
import { pool } from '../db/client.ts';
import { redis } from '../lib/redis.ts';
import { registerShutdown } from '../lib/shutdown.ts';

const ctx = { logger, db: pool, redis };

const newsWorker = new Worker(
  'news',
  async (job) => fetchNewsProcessor(job, ctx),
  {
    connection: workerConnection,
    concurrency: 3,
    limiter: { max: 10, duration: 1000 },  // rate limit: 10 jobs/sec
  },
);

newsWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'job failed');
});

registerShutdown('news-worker', async () => { await newsWorker.close(); });

logger.info('worker process ready');
```

The pool and redis shutdown handlers are already registered by their respective modules (`src/db/client.ts`, `src/lib/redis.ts`), so the worker only needs to register its own `Worker.close()`.

**Worker config rules:**

- `concurrency`: how many jobs this worker processes in parallel. Default 1; increase based on CPU/IO profile.
- `limiter`: rate limit jobs per duration. Use for external APIs with quotas.
- Always register a shutdown handler. Workers must finish in-flight jobs before exit.

## Connection management (critical)

Workers and producers need **different ioredis configurations**. The factories live in `src/lib/redis.ts`; `src/workers/_connection.ts` is a thin re-export so workers can import from a single place:

```typescript
// src/workers/_connection.ts
import { createWorkerRedis, createProducerRedis } from '../lib/redis.ts';

// Workers block on BRPOPLPUSH — must NOT retry per request.
// createWorkerRedis() applies: maxRetriesPerRequest: null, enableReadyCheck: false
export const workerConnection = createWorkerRedis();

// Producers should fail fast on Redis issues.
// createProducerRedis() applies: maxRetriesPerRequest: 3
export const producerConnection = createProducerRedis();
```

Mixing these up will cause subtle production failures. The worker connection setting is documented in BullMQ's "going to production" guide for a reason.

## Scheduling repeatable jobs

```typescript
// src/workers/schedules.ts
import { newsQueue } from './queues.ts';

export async function registerSchedules() {
  await newsQueue.add(
    'daily-fetch',
    { url: 'https://example.com/feed', topic: 'tech' },
    {
      repeat: { pattern: '0 */6 * * *' },  // every 6 hours
      jobId: 'daily-news-tech',             // stable ID prevents duplicates on restart
    },
  );
}
```

Call `registerSchedules()` from `src/workers/index.ts` once, after worker startup. The `jobId` makes it idempotent — restarting the worker won't create duplicate schedules.

## Enqueuing from a tool

Tools receive queues via `ctx`:

```typescript
// In a tool handler
const job = await ctx.queues.news.add('on-demand-fetch', {
  url: input.url,
  topic: input.topic,
});

return {
  content: [{ type: 'text', text: `Fetch queued. Job ID: ${job.id}` }],
};
```

## Testing workers

Unit-test the **processor** function directly. Integration-test the wiring with a real Redis container.

```typescript
// src/workers/processors/fetch-news.test.ts
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fetchNewsProcessor } from './fetch-news.ts';

describe('fetchNewsProcessor', () => {
  const makeJob = (data: any) => ({
    id: 'test-job',
    data,
    updateProgress: mock.fn(async () => {}),
  });

  const makeCtx = (overrides = {}) => ({
    logger: { info: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: {},
    ...overrides,
  });

  it('fetches and stores articles', async () => {
    const ctx = makeCtx();
    const job = makeJob({ url: 'https://example.com', topic: 'tech' });
    const result = await fetchNewsProcessor(job as any, ctx as any);
    assert.equal(typeof result.articlesFetched, 'number');
    assert.equal(ctx.db.query.mock.callCount(), 1);
  });
});
```

Integration tests in `tests/integration/worker.test.ts` use Testcontainers to spin up real Redis + Postgres and exercise the full Queue → Worker → DB flow.

## Common pitfalls

- **Forgetting `maxRetriesPerRequest: null` on worker connection** — silent failures after Redis hiccups.
- **Non-idempotent processors** — retries cause duplicates. Use job IDs, upserts, or transactional outbox patterns.
- **Forgetting `removeOnComplete`** — completed jobs accumulate forever in Redis, eventually exhausting memory.
- **Putting business logic in `index.ts`** — makes it untestable. Keep wiring thin, processors pure.
- **Using the same connection for producer and worker** — works in dev, breaks in production under load.
- **Cron jobs with random `jobId`** — duplicates on every restart. Always use a stable `jobId`.

## When you need to break a rule

Long-running jobs (>1 hour), jobs requiring exclusive locks, or jobs with unusual retry semantics — **stop and ask the user**. BullMQ supports advanced patterns (job locks, parent/child jobs, flow producers) but these add complexity and should be deliberate.
