import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { afterEach, describe, it, mock } from 'node:test';
import type { Redis } from 'ioredis';
import {
  __setRedisForTesting,
  attachErrorLogging,
  createRedis,
  getRedis,
  gracefulClose,
  REDIS_OPTIONS,
  redis,
  registerRedisShutdown,
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

describe('REDIS_OPTIONS', () => {
  it('uses maxRetriesPerRequest 3', () => {
    assert.equal(REDIS_OPTIONS.maxRetriesPerRequest, 3);
  });

  it('is frozen', () => {
    assert.equal(Object.isFrozen(REDIS_OPTIONS), true);
  });
});

describe('createRedis', () => {
  it('instantiates with redis options via the provided factory', () => {
    const fake = makeFakeRedis();
    const factory = mock.fn(() => fake as unknown as Redis);
    createRedis(factory);
    assert.equal(factory.mock.callCount(), 1);
    const args = factory.mock.calls[0]?.arguments as unknown as [string, typeof REDIS_OPTIONS];
    assert.equal(typeof args[0], 'string');
    assert.deepEqual(args[1], REDIS_OPTIONS);
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
      log as unknown as Parameters<typeof attachErrorLogging>[1],
    );
    const err = new Error('boom');
    fake.emit('error', err);
    assert.equal(log.error.mock.callCount(), 1);
    const [payload, msg] = log.error.mock.calls[0]?.arguments ?? [];
    assert.equal((payload as { err: Error }).err, err);
    assert.equal((payload as { role: string }).role, 'redis');
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
    __setRedisForTesting(null);
  });

  it('getRedis caches the first created client', () => {
    const fake = makeFakeRedis();
    __setRedisForTesting(fake as unknown as Redis);
    assert.equal(getRedis(), fake as unknown as Redis);
    assert.equal(getRedis(), fake as unknown as Redis);
  });

  it('redis Proxy delegates reads to the cached client', () => {
    const fake = makeFakeRedis();
    const getter = mock.fn(async () => 'value' as const);
    fake.get = getter as FakeRedis['get'];
    __setRedisForTesting(fake as unknown as Redis);
    // biome-ignore lint/suspicious/noExplicitAny: Proxy traps use any
    const proxied = (redis as any).get;
    assert.equal(typeof proxied, 'function');
    void proxied('k');
    assert.equal(getter.mock.callCount(), 1);
  });

  it('redis Proxy reports `in` via getRedis', () => {
    const fake = makeFakeRedis();
    __setRedisForTesting(fake as unknown as Redis);
    assert.equal('quit' in redis, true);
  });

  it('getRedis lazily constructs when no override is set', () => {
    __setRedisForTesting(null);
    const fake = makeFakeRedis();
    __setRedisForTesting(fake as unknown as Redis);
    assert.equal(getRedis(), fake as unknown as Redis);
  });
});
