import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { ApiKeyRecord, ApiKeyRepository } from '../db/repos/api-keys.ts';
import {
  AuthInvalidCredentialsError,
  AuthMalformedTokenError,
  AuthRequiredError,
  KeyBlacklistedError,
  KeyDeletedError,
} from '../lib/errors.ts';
import { authenticate } from './auth.ts';
import { generateApiKey, hashApiKey } from './auth-hash.ts';

function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: '7c4f8b1d-0000-4000-8000-000000000000',
    keyPrefix: 'mcp_live_k7H',
    keyHash: 'a'.repeat(64),
    name: 'Production CI',
    status: 'active',
    rateLimitPerMinute: 60,
    allowNoOrigin: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastUsedAt: null,
    blacklistedAt: null,
    deletedAt: null,
    requestCount: 0n,
    bytesIn: 0n,
    bytesOut: 0n,
    totalComputeMs: 0n,
    ...overrides,
  };
}

interface RepoMocks {
  repo: ApiKeyRepository;
  findByHash: ReturnType<typeof mock.fn>;
  touchLastUsed: ReturnType<typeof mock.fn>;
}

function makeRepo(result: ApiKeyRecord | null, touchImpl?: () => Promise<void>): RepoMocks {
  const findByHash = mock.fn(async () => result);
  const touchLastUsed = mock.fn(touchImpl ?? (async () => undefined));
  const repo = {
    findByHash,
    touchLastUsed,
  } as unknown as ApiKeyRepository;
  return { repo, findByHash, touchLastUsed };
}

describe('authenticate — malformed / missing input', () => {
  it('rejects a missing Authorization header with AuthRequiredError (-32001)', async () => {
    const { repo, findByHash } = makeRepo(null);
    const result = await authenticate(undefined, repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof AuthRequiredError);
      assert.equal(result.error.jsonRpcCode, -32001);
      assert.equal(result.error.publicMessage, 'Authentication required.');
    }
    assert.equal(findByHash.mock.callCount(), 0);
  });

  it('rejects a header without the Bearer prefix with AuthRequiredError', async () => {
    const { repo } = makeRepo(null);
    const result = await authenticate('Basic abc', repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof AuthRequiredError);
    }
  });

  it('rejects an empty bearer token with AuthMalformedTokenError (-32002)', async () => {
    const { repo, findByHash } = makeRepo(null);
    const result = await authenticate('Bearer ', repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof AuthMalformedTokenError);
      assert.equal(result.error.jsonRpcCode, -32002);
      assert.equal(result.error.publicMessage, 'Authentication required.');
    }
    assert.equal(findByHash.mock.callCount(), 0);
  });

  it('rejects a token that fails the format regex', async () => {
    const { repo } = makeRepo(null);
    const result = await authenticate('Bearer not-a-valid-mcp-key', repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof AuthMalformedTokenError);
    }
  });

  it('rejects a token that looks close but has wrong body length', async () => {
    const { repo } = makeRepo(null);
    // 42 body chars instead of the required 43
    const bad = `mcp_live_${'A'.repeat(42)}`;
    const result = await authenticate(`Bearer ${bad}`, repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof AuthMalformedTokenError);
    }
  });
});

describe('authenticate — unknown key', () => {
  it('returns AuthInvalidCredentialsError (-32003) when findByHash misses', async () => {
    const { repo, findByHash } = makeRepo(null);
    const token = generateApiKey();
    const result = await authenticate(`Bearer ${token}`, repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof AuthInvalidCredentialsError);
      assert.equal(result.error.jsonRpcCode, -32003);
      assert.equal(result.error.publicMessage, 'Authentication failed.');
    }
    assert.equal(findByHash.mock.callCount(), 1);
    assert.deepEqual(findByHash.mock.calls[0]?.arguments, [hashApiKey(token)]);
  });
});

describe('authenticate — blacklisted / deleted', () => {
  it('returns KeyBlacklistedError with the documented public message', async () => {
    const { repo, touchLastUsed } = makeRepo(makeRecord({ status: 'blacklisted' }));
    const result = await authenticate(`Bearer ${generateApiKey()}`, repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof KeyBlacklistedError);
      assert.equal(result.error.jsonRpcCode, -32004);
      assert.equal(result.error.publicMessage, 'This API key has been blocked.');
    }
    // Do NOT touch last_used_at on rejected auth.
    assert.equal(touchLastUsed.mock.callCount(), 0);
  });

  it('returns KeyDeletedError with the documented public message', async () => {
    const { repo, touchLastUsed } = makeRepo(makeRecord({ status: 'deleted' }));
    const result = await authenticate(`Bearer ${generateApiKey()}`, repo);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.ok(result.error instanceof KeyDeletedError);
      assert.equal(result.error.jsonRpcCode, -32005);
      assert.equal(result.error.publicMessage, 'This API key has been deleted.');
    }
    assert.equal(touchLastUsed.mock.callCount(), 0);
  });
});

describe('authenticate — success', () => {
  it('returns ok with the AuthenticatedKey projection', async () => {
    const record = makeRecord({
      id: 'key-id-1',
      keyPrefix: 'mcp_live_abc',
      name: 'Prod',
      rateLimitPerMinute: 120,
      allowNoOrigin: true,
    });
    const { repo } = makeRepo(record);
    const result = await authenticate(`Bearer ${generateApiKey()}`, repo);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.key, {
        id: 'key-id-1',
        prefix: 'mcp_live_abc',
        name: 'Prod',
        rateLimitPerMinute: 120,
        allowNoOrigin: true,
      });
    }
  });

  it('fires touchLastUsed without awaiting before returning', async () => {
    let released: (() => void) | undefined;
    // touchLastUsed stays pending until we release it — authenticate must still resolve.
    const pending = new Promise<void>((resolve) => {
      released = resolve;
    });
    const { repo, touchLastUsed } = makeRepo(makeRecord(), () => pending);
    const result = await authenticate(`Bearer ${generateApiKey()}`, repo);
    assert.equal(result.ok, true);
    // The method was called but still pending — i.e. not awaited.
    assert.equal(touchLastUsed.mock.callCount(), 1);
    released?.();
    await pending;
  });

  it('swallows touchLastUsed failures so they do not break the auth flow', async () => {
    const { repo } = makeRepo(makeRecord(), async () => {
      throw new Error('db blip');
    });
    const result = await authenticate(`Bearer ${generateApiKey()}`, repo);
    assert.equal(result.ok, true);
    // Give the rejected promise one tick to flush through the .catch handler.
    await new Promise((r) => setImmediate(r));
  });

  it('calls touchLastUsed with the record id', async () => {
    const { repo, touchLastUsed } = makeRepo(makeRecord({ id: 'id-42' }));
    await authenticate(`Bearer ${generateApiKey()}`, repo);
    assert.deepEqual(touchLastUsed.mock.calls[0]?.arguments, ['id-42']);
  });
});

describe('authenticate — KEY_BODY_REGEX anchors', () => {
  it('accepts both mcp_live_ and mcp_test_ prefixes', async () => {
    const { repo: liveRepo, findByHash: liveFind } = makeRepo(null);
    await authenticate(`Bearer ${generateApiKey('mcp_live')}`, liveRepo);
    assert.equal(liveFind.mock.callCount(), 1);

    const { repo: testRepo, findByHash: testFind } = makeRepo(null);
    await authenticate(`Bearer ${generateApiKey('mcp_test')}`, testRepo);
    assert.equal(testFind.mock.callCount(), 1);
  });

  it('rejects keys with disallowed prefixes before any DB lookup', async () => {
    const { repo, findByHash } = makeRepo(null);
    // mcp_prod is not a valid environment prefix per SECURITY Rule 3.
    const bad = `mcp_prod_${'A'.repeat(43)}`;
    const result = await authenticate(`Bearer ${bad}`, repo);
    assert.equal(result.ok, false);
    assert.equal(findByHash.mock.callCount(), 0);
  });
});
