import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import { buildRedactor, REDACTED_VALUE } from './redact.ts';

describe('buildRedactor', () => {
  it('returns the identity function when no field is marked sensitive', () => {
    const shape = {
      query: z.string(),
      limit: z.number().int(),
    };
    const redact = buildRedactor(shape);
    const input = { query: 'hello', limit: 5 };
    // No allocation on the hot path — identity returns the same reference.
    assert.strictEqual(redact(input), input);
  });

  it('replaces a sensitive field with the REDACTED marker', () => {
    const shape = {
      webhook_url: z.string().url(),
      api_token: z.string().min(10).meta({ sensitive: true }),
    };
    const redact = buildRedactor(shape);
    const out = redact({ webhook_url: 'https://example.com/hook', api_token: 'super-secret-123' });
    assert.equal(out.webhook_url, 'https://example.com/hook');
    assert.equal(out.api_token, REDACTED_VALUE);
  });

  it('preserves non-sensitive fields verbatim even when a sensitive field is present', () => {
    const shape = {
      query: z.string(),
      password: z.string().meta({ sensitive: true }),
      limit: z.number().int(),
    };
    const redact = buildRedactor(shape);
    const out = redact({ query: 'test', password: 'hunter2', limit: 42 });
    assert.equal(out.query, 'test');
    assert.equal(out.password, REDACTED_VALUE);
    assert.equal(out.limit, 42);
  });

  it('handles sensitive fields regardless of chained modifiers', () => {
    const shape = {
      // meta placed before describe
      token_a: z.string().meta({ sensitive: true }).describe('A token'),
      // meta placed after min/max
      token_b: z.string().min(5).max(200).meta({ sensitive: true }),
      // meta on a default
      token_c: z.string().default('fallback').meta({ sensitive: true }),
    };
    const redact = buildRedactor(shape);
    const out = redact({ token_a: 'a', token_b: 'bbbbb', token_c: 'c' });
    assert.equal(out.token_a, REDACTED_VALUE);
    assert.equal(out.token_b, REDACTED_VALUE);
    assert.equal(out.token_c, REDACTED_VALUE);
  });

  it('ignores meta whose sensitive flag is not literally true', () => {
    const shape = {
      maybe_secret_a: z.string().meta({ sensitive: false }),
      maybe_secret_b: z.string().meta({ sensitive: 'yes' as unknown as boolean }),
      maybe_secret_c: z.string().meta({ description: 'not sensitive' }),
    };
    const redact = buildRedactor(shape);
    const out = redact({ maybe_secret_a: 'v1', maybe_secret_b: 'v2', maybe_secret_c: 'v3' });
    assert.equal(out.maybe_secret_a, 'v1');
    assert.equal(out.maybe_secret_b, 'v2');
    assert.equal(out.maybe_secret_c, 'v3');
  });

  it('returns a copy so callers cannot mutate the caller-provided args object', () => {
    const shape = { secret: z.string().meta({ sensitive: true }), other: z.string() };
    const redact = buildRedactor(shape);
    const input = { secret: 'x', other: 'y' };
    const out = redact(input);
    assert.notStrictEqual(out, input);
    assert.equal(input.secret, 'x'); // original unchanged
  });
});
