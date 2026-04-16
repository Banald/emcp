import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../lib/errors.ts';

// Import the module to trigger the validateInput path — the createRateLimiter
// function itself requires a real Redis connection (integration tests cover it).
// Here we test only the input validation that throws synchronously.
import { createRateLimiter } from './rate-limiter.ts';

// Minimal Redis stub — just enough for defineCommand to not throw.
function makeStubRedis() {
  return {
    defineCommand: () => {},
  } as never;
}

describe('rate-limiter input validation', () => {
  const limiter = createRateLimiter(makeStubRedis());

  it('throws ValidationError for limit = 0', async () => {
    await assert.rejects(
      () => limiter.check({ scope: 'test', limit: 0, windowMs: 60_000 }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /positive integer/);
        return true;
      },
    );
  });

  it('throws ValidationError for negative limit', async () => {
    await assert.rejects(
      () => limiter.check({ scope: 'test', limit: -5, windowMs: 60_000 }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it('throws ValidationError for NaN limit', async () => {
    await assert.rejects(
      () => limiter.check({ scope: 'test', limit: NaN, windowMs: 60_000 }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it('throws ValidationError for Infinity limit', async () => {
    await assert.rejects(
      () => limiter.check({ scope: 'test', limit: Infinity, windowMs: 60_000 }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });

  it('throws ValidationError for windowMs = 0', async () => {
    await assert.rejects(
      () => limiter.check({ scope: 'test', limit: 10, windowMs: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        assert.match(err.message, /positive integer/);
        return true;
      },
    );
  });

  it('throws ValidationError for negative windowMs', async () => {
    await assert.rejects(
      () => limiter.check({ scope: 'test', limit: 10, windowMs: -1000 }),
      (err: unknown) => {
        assert.ok(err instanceof ValidationError);
        return true;
      },
    );
  });
});
