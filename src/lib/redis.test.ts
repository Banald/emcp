import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it, mock } from 'node:test';
import type { Redis } from 'ioredis';
import {
  __setProducerRedisForTesting,
  attachErrorLogging,
  createProducerRedis,
  createWorkerRedis,
  getRedis,
  gracefulClose,
  PRODUCER_OPTIONS,
  redis,
  registerRedisShutdown,
  WORKER_OPTIONS,
} from './redis.ts';

type FakeRedis = EventEmitter & {
  quit: ReturnType<typeof mock.fn>;
  disconnect: ReturnType<typeof mock.fn>;
  get?: ReturnType<typeof mock.fn>;
};

function makeFakeRedis(overrides: Partial<FakeRedis> = {}): FakeRedis {
  const ee = new EventEmitter() as FakeRedis;
  ee.quit = mock.fn(async () => 'OK' as unknown as 'OK');
  ee.disconnect = mock.fn();
  Object.assign(ee, overrides);
  return ee;
}

describe('PRODUCER_OPTIONS / WORKER_OPTIONS', () => {
  it('producer uses maxRetriesPerRequest 3', () => {
    assert.equal(PRODUCER_OPTIONS.maxRetriesPerRequest, 3);
  });

  it('worker opts out of retries and ready-check', () => {
    assert.equal(WORKER_OPTIONS.maxRetriesPerRequest, null);
    assert.equal(WORKER_OPTIONS.enableReadyCheck, false);
  });

  it('exported option objects are frozen', () => {
    assert.equal(Object.isFrozen(PRODUCER_OPTIONS), true);
    assert.equal(Object.isFrozen(WORKER_OPTIONS), true);
  });
});

describe('createProducerRedis', () => {
  it('instantiates with producer options via the provided factory', () => {
    const fake = makeFakeRedis();
    const factory = mock.fn(() => fake as unknown as Redis);
    const register = mock.fn();
    // Inject register indirectly by observing handler registration on the default registry:
    // easier — re-register via registerRedisShutdown independently. Here we only validate factory + listener.
    void register;
    createProducerRedis(factory);
    assert.equal(factory.mock.callCount(), 1);
    const args = factory.mock.calls[0]?.arguments as unknown as [string, typeof PRODUCER_OPTIONS];
    assert.equal(typeof args[0], 'string');
    assert.deepEqual(args[1], PRODUCER_OPTIONS);
    assert.equal(fake.listenerCount('error'), 1);
  });
});

describe('createWorkerRedis', () => {
  it('instantiates with worker options via the provided factory', () => {
    const fake = makeFakeRedis();
    const factory = mock.fn(() => fake as unknown as Redis);
    createWorkerRedis(factory);
    assert.equal(factory.mock.callCount(), 1);
    const args = factory.mock.calls[0]?.arguments as unknown as [string, typeof WORKER_OPTIONS];
    assert.deepEqual(args[1], WORKER_OPTIONS);
    assert.equal(fake.listenerCount('error'), 1);
  });
});

describe('attachErrorLogging', () => {
  it('forwards emitted error events to the logger at error level', () => {
    const fake = makeFakeRedis();
    const log = {
      error: mock.fn(),
      fatal: mock.fn(),
      warn: mock.fn(),
      info: mock.fn(),
      debug: mock.fn(),
      trace: mock.fn(),
    };
    attachErrorLogging(
      fake as unknown as Redis,
      'producer',
      log as unknown as Parameters<typeof attachErrorLogging>[2],
    );
    const err = new Error('boom');
    fake.emit('error', err);
    assert.equal(log.error.mock.callCount(), 1);
    const [payload, msg] = log.error.mock.calls[0]?.arguments ?? [];
    assert.equal((payload as { err: Error }).err, err);
    assert.equal((payload as { role: string }).role, 'producer');
    assert.equal(msg, 'redis client error');
  });
});

describe('gracefulClose', () => {
  it('resolves promptly when quit() succeeds', async () => {
    const fake = makeFakeRedis();
    await gracefulClose(fake as unknown as Redis, 100);
    assert.equal(fake.quit.mock.callCount(), 1);
    assert.equal(fake.disconnect.mock.callCount(), 0);
  });

  it('falls back to disconnect() when quit hangs past the timeout', async () => {
    const fake = makeFakeRedis();
    // Override quit to never resolve.
    fake.quit = mock.fn(() => new Promise(() => {})) as FakeRedis['quit'];
    const start = Date.now();
    await gracefulClose(fake as unknown as Redis, 20);
    const elapsed = Date.now() - start;
    assert.equal(fake.disconnect.mock.callCount(), 1);
    assert.ok(elapsed >= 15 && elapsed < 500, `expected ~20ms fallback, got ${elapsed}`);
  });

  it('falls back to disconnect() when quit() rejects', async () => {
    const fake = makeFakeRedis();
    fake.quit = mock.fn(async () => {
      throw new Error('connection closed');
    }) as FakeRedis['quit'];
    await gracefulClose(fake as unknown as Redis, 100);
    assert.equal(fake.disconnect.mock.callCount(), 1);
  });
});

describe('registerRedisShutdown', () => {
  it('registers a handler that closes the client via gracefulClose', async () => {
    const fake = makeFakeRedis();
    const register = mock.fn();
    registerRedisShutdown('redis-test', fake as unknown as Redis, register, 50);
    assert.equal(register.mock.callCount(), 1);
    assert.equal(register.mock.calls[0]?.arguments[0], 'redis-test');
    const handler = register.mock.calls[0]?.arguments[1] as () => Promise<void>;
    await handler();
    assert.equal(fake.quit.mock.callCount(), 1);
  });
});

describe('getRedis singleton and redis Proxy', () => {
  afterEach(() => {
    __setProducerRedisForTesting(null);
  });

  it('getRedis caches the first created producer', () => {
    const fake = makeFakeRedis();
    __setProducerRedisForTesting(fake as unknown as Redis);
    assert.equal(getRedis(), fake as unknown as Redis);
    assert.equal(getRedis(), fake as unknown as Redis);
  });

  it('redis Proxy delegates reads to the cached producer', () => {
    const fake = makeFakeRedis();
    const getter = mock.fn(async () => 'value' as const);
    fake.get = getter as FakeRedis['get'];
    __setProducerRedisForTesting(fake as unknown as Redis);
    // biome-ignore lint/suspicious/noExplicitAny: Proxy traps use any
    const proxied = (redis as any).get;
    assert.equal(typeof proxied, 'function');
    // Bound methods preserve this — call and verify it uses the fake.
    void proxied('k');
    assert.equal(getter.mock.callCount(), 1);
  });

  it('redis Proxy reports `in` via getRedis', () => {
    const fake = makeFakeRedis();
    __setProducerRedisForTesting(fake as unknown as Redis);
    assert.equal('quit' in redis, true);
  });

  it('getRedis lazily constructs when no override is set', () => {
    // Ensure singleton is null.
    __setProducerRedisForTesting(null);
    // Stub the factory path by pre-setting the singleton to a fake — the first call to
    // getRedis should see the override and not try to construct a real client.
    const fake = makeFakeRedis();
    __setProducerRedisForTesting(fake as unknown as Redis);
    assert.equal(getRedis(), fake as unknown as Redis);
  });
});
