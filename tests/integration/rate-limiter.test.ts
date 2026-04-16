import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Redis } from 'ioredis';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { createRateLimiter, type RateLimiter } from '../../src/core/rate-limiter.ts';

describe('rate-limiter integration (real Redis)', { timeout: 120_000 }, () => {
  let container: StartedTestContainer;
  let redis: Redis;
  let limiter: RateLimiter;

  before(async () => {
    container = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    redis = new Redis({
      host: 'localhost',
      port: container.getMappedPort(6379),
      maxRetriesPerRequest: 3,
    });

    limiter = createRateLimiter(redis);
  });

  after(async () => {
    redis.disconnect();
    await container.stop();
  });

  it('allows sequential requests within the limit', async () => {
    const scope = `test:sequential:${Date.now()}`;
    const limit = 5;

    for (let i = 0; i < limit; i++) {
      const result = await limiter.check({ scope, limit, windowMs: 60_000 });
      assert.equal(result.allowed, true, `request ${i + 1} should be allowed`);
      assert.equal(result.remaining, limit - i - 1, `remaining should decrement`);
      assert.equal(result.limit, limit);
    }
  });

  it('denies a request beyond the limit', async () => {
    const scope = `test:deny:${Date.now()}`;
    const limit = 3;

    for (let i = 0; i < limit; i++) {
      const result = await limiter.check({ scope, limit, windowMs: 60_000 });
      assert.equal(result.allowed, true);
    }

    const denied = await limiter.check({ scope, limit, windowMs: 60_000 });
    assert.equal(denied.allowed, false);
    assert.equal(denied.remaining, 0);
    assert.ok(denied.retryAfterSec !== undefined, 'expected retryAfterSec');
    assert.ok((denied.retryAfterSec ?? 0) > 0, 'retryAfterSec should be positive');
  });

  it('refreshes after the window passes', async () => {
    const scope = `test:refresh:${Date.now()}`;
    const limit = 2;
    const windowMs = 1_000; // 1 second window for fast test

    for (let i = 0; i < limit; i++) {
      await limiter.check({ scope, limit, windowMs });
    }
    const denied = await limiter.check({ scope, limit, windowMs });
    assert.equal(denied.allowed, false);

    // Wait for the window to expire.
    await new Promise((r) => setTimeout(r, windowMs + 200));

    const fresh = await limiter.check({ scope, limit, windowMs });
    assert.equal(fresh.allowed, true, 'should be allowed after window expires');
    assert.equal(fresh.remaining, limit - 1);
  });

  it('different scopes are independent', async () => {
    const scopeA = `test:scopeA:${Date.now()}`;
    const scopeB = `test:scopeB:${Date.now()}`;
    const limit = 2;

    // Exhaust scope A.
    for (let i = 0; i < limit; i++) {
      await limiter.check({ scope: scopeA, limit, windowMs: 60_000 });
    }
    const deniedA = await limiter.check({ scope: scopeA, limit, windowMs: 60_000 });
    assert.equal(deniedA.allowed, false);

    // Scope B should still have capacity.
    const allowedB = await limiter.check({ scope: scopeB, limit, windowMs: 60_000 });
    assert.equal(allowedB.allowed, true);
    assert.equal(allowedB.remaining, limit - 1);
  });

  it('concurrent requests at boundary allow exactly N', async () => {
    const scope = `test:concurrent:${Date.now()}`;
    const limit = 10;

    // Fire limit + 5 requests concurrently.
    const promises = Array.from({ length: limit + 5 }, () =>
      limiter.check({ scope, limit, windowMs: 60_000 }),
    );
    const results = await Promise.all(promises);
    const allowed = results.filter((r) => r.allowed).length;
    const denied = results.filter((r) => !r.allowed).length;

    assert.equal(allowed, limit, `exactly ${limit} should be allowed`);
    assert.equal(denied, 5, 'exactly 5 should be denied');
  });
});
