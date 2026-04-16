import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Pool } from 'pg';
import { createLogger } from '../../lib/logger.ts';
import type { CronFactory, CronHandle, SchedulerMetrics } from './scheduler.ts';
import { createScheduler } from './scheduler.ts';
import type { WorkerDefinition } from './types.ts';

function makeLogger() {
  return createLogger({ level: 'silent' });
}

function makeMetrics(): SchedulerMetrics & {
  inc: ReturnType<typeof mock.fn>;
  observe: ReturnType<typeof mock.fn>;
} {
  const inc = mock.fn();
  const observe = mock.fn();
  return {
    inc,
    observe,
    runsTotal: { inc: (labels) => inc(labels) },
    runDuration: { observe: (labels, v) => observe(labels, v) },
  };
}

interface FakeCron extends CronHandle {
  trigger(): void;
  stopped: boolean;
  schedule: string;
  timezone?: string;
}

function makeCronFactory(): { factory: CronFactory; handles: FakeCron[] } {
  const handles: FakeCron[] = [];
  const factory: CronFactory = (pattern, opts, onTick) => {
    const handle: FakeCron = {
      stopped: false,
      schedule: pattern,
      timezone: opts.timezone,
      stop: () => {
        handle.stopped = true;
      },
      trigger: () => onTick(),
    };
    handles.push(handle);
    return handle;
  };
  return { factory, handles };
}

const fakeDb = {} as unknown as Pool;

function makeAbortController() {
  return new AbortController();
}

describe('createScheduler', () => {
  it('schedules a worker and records success on tick', async () => {
    const handler = mock.fn(async () => {});
    const worker: WorkerDefinition = {
      name: 'hello',
      schedule: '* * * * *',
      handler,
    };
    const metrics = makeMetrics();
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics,
    });

    await sch.start();
    assert.equal(handles.length, 1);
    assert.equal(handles[0]?.schedule, '* * * * *');

    handles[0]?.trigger();
    // Wait for the async fire to settle.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(handler.mock.callCount(), 1);
    const incCalls = metrics.inc.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(incCalls, [{ worker: 'hello', status: 'success' }]);
    assert.equal(metrics.observe.mock.callCount(), 1);

    await sch.stop(1_000);
  });

  it('records failure when handler throws', async () => {
    const handler = mock.fn(async () => {
      throw new Error('boom');
    });
    const worker: WorkerDefinition = { name: 'fails', schedule: '* * * * *', handler };
    const metrics = makeMetrics();
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics,
    });

    await sch.start();
    handles[0]?.trigger();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    const incCalls = metrics.inc.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(incCalls, [{ worker: 'fails', status: 'failure' }]);
    assert.equal(metrics.observe.mock.callCount(), 1);

    await sch.stop(1_000);
  });

  it('skips a second tick that arrives while the first is in-flight', async () => {
    let release: (() => void) | undefined;
    const handler = mock.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const worker: WorkerDefinition = {
      name: 'slow',
      schedule: '* * * * *',
      handler,
    };
    const metrics = makeMetrics();
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics,
    });

    await sch.start();

    handles[0]?.trigger();
    // Yield so runOnce can set inFlight = true before the second trigger.
    await new Promise((r) => setImmediate(r));

    handles[0]?.trigger();
    await new Promise((r) => setImmediate(r));

    assert.equal(handler.mock.callCount(), 1);
    const incCalls = metrics.inc.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(incCalls, [{ worker: 'slow', status: 'skipped_overlap' }]);

    release?.();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    await sch.stop(1_000);
  });

  it('records timeout when handler ignores the signal', async () => {
    const handler = mock.fn(async () => {
      await new Promise(() => {}); // never resolves
    });
    const worker: WorkerDefinition = {
      name: 'wedged',
      schedule: '* * * * *',
      handler,
      timeoutMs: 30,
    };
    const metrics = makeMetrics();
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics,
    });

    await sch.start();

    handles[0]?.trigger();
    // Wait long enough for the 30ms timeout to fire and the handler to settle.
    await new Promise((r) => setTimeout(r, 120));

    const incCalls = metrics.inc.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(incCalls, [{ worker: 'wedged', status: 'timeout' }]);
    assert.equal(metrics.observe.mock.callCount(), 1);

    await sch.stop(500);
  });

  it('runOnStartup fires once during start before any cron tick', async () => {
    const handler = mock.fn(async () => {});
    const worker: WorkerDefinition = {
      name: 'boot',
      schedule: '* * * * *',
      handler,
      runOnStartup: true,
    };
    const metrics = makeMetrics();
    const { factory } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics,
    });

    await sch.start();

    assert.equal(handler.mock.callCount(), 1);
    const incCalls = metrics.inc.mock.calls.map((c) => c.arguments[0]);
    assert.deepEqual(incCalls, [{ worker: 'boot', status: 'success' }]);

    await sch.stop(1_000);
  });

  it('stop waits for an in-flight handler to resolve', async () => {
    let release: (() => void) | undefined;
    const handler = mock.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const worker: WorkerDefinition = { name: 'wait', schedule: '* * * * *', handler };
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics: makeMetrics(),
    });

    await sch.start();
    handles[0]?.trigger();
    await new Promise((r) => setImmediate(r));

    const stopPromise = sch.stop(2_000);
    // Release in 80ms — well under the grace timeout.
    setTimeout(() => release?.(), 80);

    await stopPromise;
    assert.equal(handles[0]?.stopped, true);
  });

  it('stop resolves after grace timeout even if handler never resolves', async () => {
    const handler = mock.fn(() => new Promise<void>(() => {}));
    const worker: WorkerDefinition = { name: 'stuck', schedule: '* * * * *', handler };
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics: makeMetrics(),
    });

    await sch.start();
    handles[0]?.trigger();
    await new Promise((r) => setImmediate(r));

    const start = Date.now();
    await sch.stop(100);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 90 && elapsed < 1_000, `expected grace to elapse (got ${elapsed}ms)`);
  });

  it('refuses subsequent fires after stop', async () => {
    const handler = mock.fn(async () => {});
    const worker: WorkerDefinition = { name: 'done', schedule: '* * * * *', handler };
    const metrics = makeMetrics();
    const { factory, handles } = makeCronFactory();
    const shutdown = makeAbortController();

    const sch = createScheduler({
      workers: [worker],
      db: fakeDb,
      logger: makeLogger(),
      shutdownSignal: shutdown.signal,
      cronFactory: factory,
      metrics,
    });

    await sch.start();
    await sch.stop(100);

    handles[0]?.trigger();
    await new Promise((r) => setImmediate(r));

    assert.equal(handler.mock.callCount(), 0);
    assert.equal(metrics.inc.mock.callCount(), 0);
  });
});
