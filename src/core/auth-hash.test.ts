import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractKeyPrefix,
  generateApiKey,
  hashApiKey,
  hmacSha256Hex,
  KEY_BODY_REGEX,
  KEY_PREFIX_LENGTH,
  verifyApiKey,
} from './auth-hash.ts';

describe('generateApiKey', () => {
  it('produces the default mcp_live prefix', () => {
    for (let i = 0; i < 10; i++) {
      const key = generateApiKey();
      assert.match(key, /^mcp_live_[A-Za-z0-9_-]{43}$/);
    }
  });

  it('accepts a custom prefix (mcp_test for tests)', () => {
    const key = generateApiKey('mcp_test');
    assert.match(key, /^mcp_test_[A-Za-z0-9_-]{43}$/);
  });

  it('satisfies the shared KEY_BODY_REGEX', () => {
    assert.match(generateApiKey(), KEY_BODY_REGEX);
    assert.match(generateApiKey('mcp_test'), KEY_BODY_REGEX);
  });

  it('produces distinct keys on every invocation', () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) keys.add(generateApiKey());
    assert.equal(keys.size, 100);
  });

  it('encodes 32 bytes of entropy after the prefix', () => {
    const key = generateApiKey();
    const body = key.slice('mcp_live_'.length);
    // 32 bytes base64url is 43 chars unpadded — 256 bits of entropy per SECURITY Rule 3.
    assert.equal(body.length, 43);
  });
});

describe('hmacSha256Hex', () => {
  it('matches the RFC 4231-style vector (key: "key", data: fox sentence)', () => {
    // https://en.wikipedia.org/wiki/HMAC#Examples
    const expected = 'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8';
    assert.equal(hmacSha256Hex('The quick brown fox jumps over the lazy dog', 'key'), expected);
  });

  it('is deterministic for the same input and secret', () => {
    const a = hmacSha256Hex('hello', 'pepper');
    const b = hmacSha256Hex('hello', 'pepper');
    assert.equal(a, b);
  });

  it('produces different output for different secrets', () => {
    const a = hmacSha256Hex('hello', 'pepper-a');
    const b = hmacSha256Hex('hello', 'pepper-b');
    assert.notEqual(a, b);
  });

  it('always emits 64 hex characters (256 bits)', () => {
    for (const input of ['a', 'longer input', generateApiKey()]) {
      const digest = hmacSha256Hex(input, 'secret');
      assert.equal(digest.length, 64);
      assert.match(digest, /^[0-9a-f]{64}$/);
    }
  });
});

describe('hashApiKey', () => {
  it('is deterministic for the same input', () => {
    const key = 'mcp_live_testtesttesttesttesttesttesttesttesttesttest';
    assert.equal(hashApiKey(key), hashApiKey(key));
  });

  it('produces 64 hex characters', () => {
    const hash = hashApiKey(generateApiKey());
    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  it('uses the configured pepper (differs from a hash with a different pepper)', () => {
    const key = generateApiKey();
    const underOther = hmacSha256Hex(key, 'a-different-pepper');
    assert.notEqual(hashApiKey(key), underOther);
  });

  it('is equivalent to hmacSha256Hex with the config pepper', async () => {
    const { config } = await import('../config.ts');
    const key = generateApiKey();
    assert.equal(hashApiKey(key), hmacSha256Hex(key, config.apiKeyHmacSecret));
  });
});

describe('verifyApiKey', () => {
  it('returns true when provided matches the stored hash', () => {
    const key = generateApiKey();
    const hash = hashApiKey(key);
    assert.equal(verifyApiKey(key, hash), true);
  });

  it('returns false when provided does not match', () => {
    const key = generateApiKey();
    const other = generateApiKey();
    assert.equal(verifyApiKey(key, hashApiKey(other)), false);
  });

  it('returns false without throwing when hashes differ in length', () => {
    const key = generateApiKey();
    // Shorter than 64 hex chars — would cause timingSafeEqual to throw without the length guard.
    assert.doesNotThrow(() => verifyApiKey(key, 'short'));
    assert.equal(verifyApiKey(key, 'short'), false);
  });

  it('returns false when the stored hash is an empty string', () => {
    assert.equal(verifyApiKey(generateApiKey(), ''), false);
  });

  it('returns false for a well-formed hex string of the wrong length', () => {
    // Valid hex but 62 chars — hex parse succeeds, length mismatch still rejected.
    assert.equal(verifyApiKey(generateApiKey(), 'ab'.repeat(31)), false);
  });
});

describe('extractKeyPrefix', () => {
  it('returns the first 12 characters', () => {
    const key = 'mcp_live_k7Hj9mNqR2xYpL4wVbD8cE1fA3gT6iU0sK5nO9rW_Q';
    assert.equal(extractKeyPrefix(key), key.slice(0, KEY_PREFIX_LENGTH));
    assert.equal(extractKeyPrefix(key).length, KEY_PREFIX_LENGTH);
  });

  it('returns the whole string when shorter than the prefix length', () => {
    assert.equal(extractKeyPrefix('short'), 'short');
  });

  it('prefixes of generated keys are deterministic for the same body', () => {
    const key = generateApiKey();
    assert.equal(extractKeyPrefix(key), key.slice(0, KEY_PREFIX_LENGTH));
  });

  it('widens to 16 chars so the random tail gives ~42 bits of disambiguation (AUDIT L-4)', () => {
    assert.equal(KEY_PREFIX_LENGTH, 16);
  });
});
