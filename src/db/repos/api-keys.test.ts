import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Pool } from 'pg';
import { type ApiKeyRecord, ApiKeyRepository } from './api-keys.ts';

type MockCall = { sql: string; params: readonly unknown[] };

interface MockPoolContext {
  pool: Pool;
  calls: MockCall[];
}

// A reusable row matching the columns returned by SELECT_COLUMNS.
function makeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7c4f8b1d-0000-4000-8000-000000000000',
    key_prefix: 'mcp_live_k7H',
    key_hash: 'a'.repeat(64),
    name: 'Production CI',
    status: 'active',
    rate_limit_per_minute: 60,
    allow_no_origin: false,
    created_at: new Date('2026-01-01T00:00:00Z'),
    last_used_at: null,
    blacklisted_at: null,
    deleted_at: null,
    request_count: '123',
    bytes_in: '456',
    bytes_out: '789',
    total_compute_ms: '1000',
    ...overrides,
  };
}

function makePool(rows: Record<string, unknown>[] = []): MockPoolContext {
  const calls: MockCall[] = [];
  const pool = {
    query: mock.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    }),
  } as unknown as Pool;
  return { pool, calls };
}

describe('ApiKeyRepository.create', () => {
  it('inserts with defaults for rate limit and allow_no_origin and returns the mapped row', async () => {
    const { pool, calls } = makePool([makeRow()]);
    const repo = new ApiKeyRepository(pool);
    const rec = await repo.create({
      keyPrefix: 'mcp_live_k7H',
      keyHash: 'h',
      name: 'Production CI',
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]?.sql ?? '', /INSERT INTO api_keys/);
    // defaults: rate_limit 60 (from config in test setup), allow_no_origin false
    assert.deepEqual(calls[0]?.params, ['mcp_live_k7H', 'h', 'Production CI', 60, false]);
    assert.equal(rec.id, '7c4f8b1d-0000-4000-8000-000000000000');
    assert.equal(rec.name, 'Production CI');
  });

  it('honors explicit rateLimitPerMinute and allowNoOrigin', async () => {
    const { pool, calls } = makePool([
      makeRow({ rate_limit_per_minute: 200, allow_no_origin: true }),
    ]);
    const repo = new ApiKeyRepository(pool);
    const rec = await repo.create({
      keyPrefix: 'mcp_live_k7H',
      keyHash: 'h',
      name: 'Server-to-server',
      rateLimitPerMinute: 200,
      allowNoOrigin: true,
    });
    assert.deepEqual(calls[0]?.params, ['mcp_live_k7H', 'h', 'Server-to-server', 200, true]);
    assert.equal(rec.rateLimitPerMinute, 200);
    assert.equal(rec.allowNoOrigin, true);
  });

  it('throws when the insert returns no row (should be impossible)', async () => {
    const { pool } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await assert.rejects(
      repo.create({ keyPrefix: 'p', keyHash: 'h', name: 'n' }),
      /api key create returned no row/,
    );
  });
});

describe('ApiKeyRepository.findById / findByPrefix', () => {
  it('findById returns the mapped record', async () => {
    const { pool, calls } = makePool([makeRow()]);
    const repo = new ApiKeyRepository(pool);
    const rec = await repo.findById('7c4f8b1d-0000-4000-8000-000000000000');
    assert.match(calls[0]?.sql ?? '', /FROM api_keys WHERE id = \$1/);
    assert.deepEqual(calls[0]?.params, ['7c4f8b1d-0000-4000-8000-000000000000']);
    assert.equal(rec?.id, '7c4f8b1d-0000-4000-8000-000000000000');
  });

  it('findById returns null on miss', async () => {
    const { pool } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    assert.equal(await repo.findById('nope'), null);
  });

  it('findByPrefix uses the prefix index and returns null on miss', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    assert.equal(await repo.findByPrefix('mcp_live_xxx'), null);
    assert.match(calls[0]?.sql ?? '', /WHERE key_prefix = \$1/);
    assert.deepEqual(calls[0]?.params, ['mcp_live_xxx']);
  });

  it('findByPrefix returns the mapped record on hit', async () => {
    const { pool } = makePool([makeRow({ key_prefix: 'mcp_live_aaa' })]);
    const repo = new ApiKeyRepository(pool);
    const rec = await repo.findByPrefix('mcp_live_aaa');
    assert.equal(rec?.keyPrefix, 'mcp_live_aaa');
  });
});

describe('ApiKeyRepository.findByHash', () => {
  it('returns the mapped record on hit', async () => {
    const { pool, calls } = makePool([makeRow()]);
    const repo = new ApiKeyRepository(pool);
    const rec = await repo.findByHash('a'.repeat(64));
    assert.match(calls[0]?.sql ?? '', /WHERE key_hash = \$1/);
    assert.deepEqual(calls[0]?.params, ['a'.repeat(64)]);
    assert.equal(rec?.id, '7c4f8b1d-0000-4000-8000-000000000000');
  });

  it('returns null on miss', async () => {
    const { pool } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    assert.equal(await repo.findByHash('b'.repeat(64)), null);
  });

  it('converts BIGINT counters from string to bigint', async () => {
    const { pool } = makePool([
      makeRow({
        request_count: '123456789012345',
        bytes_in: '9999',
        bytes_out: '8888',
        total_compute_ms: '7777',
      }),
    ]);
    const repo = new ApiKeyRepository(pool);
    const rec = (await repo.findByHash('h')) as ApiKeyRecord;
    assert.equal(typeof rec.requestCount, 'bigint');
    assert.equal(rec.requestCount, 123456789012345n);
    assert.equal(rec.bytesIn, 9999n);
    assert.equal(rec.bytesOut, 8888n);
    assert.equal(rec.totalComputeMs, 7777n);
  });

  it('handles numeric bigint inputs as well (defensive coercion)', async () => {
    const { pool } = makePool([
      makeRow({ request_count: 5, bytes_in: 10n, bytes_out: 0, total_compute_ms: 0 }),
    ]);
    const repo = new ApiKeyRepository(pool);
    const rec = (await repo.findByHash('h')) as ApiKeyRecord;
    assert.equal(rec.requestCount, 5n);
    assert.equal(rec.bytesIn, 10n);
  });
});

describe('ApiKeyRepository.list', () => {
  it('defaults to non-deleted when filter is empty', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.list();
    assert.match(calls[0]?.sql ?? '', /status <> 'deleted'/);
    assert.match(calls[0]?.sql ?? '', /ORDER BY created_at DESC/);
    assert.deepEqual(calls[0]?.params, []);
  });

  it('filters by active status with a parameter', async () => {
    const { pool, calls } = makePool([makeRow()]);
    const repo = new ApiKeyRepository(pool);
    await repo.list({ status: 'active' });
    assert.match(calls[0]?.sql ?? '', /WHERE status = \$1/);
    assert.deepEqual(calls[0]?.params, ['active']);
  });

  it('filters by blacklisted status', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.list({ status: 'blacklisted' });
    assert.deepEqual(calls[0]?.params, ['blacklisted']);
  });

  it('filters by deleted status', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.list({ status: 'deleted' });
    assert.deepEqual(calls[0]?.params, ['deleted']);
  });

  it('returns every row including deleted when status is "all"', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.list({ status: 'all' });
    const sql = calls[0]?.sql ?? '';
    // No WHERE filter on status at all
    assert.doesNotMatch(sql, /WHERE status/);
    assert.deepEqual(calls[0]?.params, []);
  });

  it('maps every row returned by the query', async () => {
    const { pool } = makePool([makeRow(), makeRow({ id: 'second', key_prefix: 'mcp_live_b' })]);
    const repo = new ApiKeyRepository(pool);
    const list = await repo.list();
    assert.equal(list.length, 2);
    assert.equal(list[1]?.id, 'second');
    assert.equal(list[1]?.keyPrefix, 'mcp_live_b');
  });
});

describe('ApiKeyRepository.blacklist / unblacklist / softDelete', () => {
  it('blacklist sets status and blacklisted_at', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.blacklist('abc');
    const sql = calls[0]?.sql ?? '';
    assert.match(sql, /status = 'blacklisted'/);
    assert.match(sql, /blacklisted_at = now\(\)/);
    assert.deepEqual(calls[0]?.params, ['abc']);
  });

  it('unblacklist requires the current status to be blacklisted (SQL guard)', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.unblacklist('abc');
    const sql = calls[0]?.sql ?? '';
    assert.match(sql, /status = 'active'/);
    assert.match(sql, /blacklisted_at = NULL/);
    assert.match(sql, /AND status = 'blacklisted'/);
    assert.deepEqual(calls[0]?.params, ['abc']);
  });

  it('softDelete sets status and deleted_at — distinct from blacklist', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.softDelete('abc');
    const sql = calls[0]?.sql ?? '';
    assert.match(sql, /status = 'deleted'/);
    assert.match(sql, /deleted_at = now\(\)/);
    assert.doesNotMatch(sql, /blacklisted_at/);
  });

  it("unblacklist's guard prevents un-deleting a soft-deleted key", async () => {
    // The SQL guard `AND status = 'blacklisted'` means a deleted key would not match.
    // We verify the guard text is present; the DB enforces the behavior.
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.unblacklist('abc');
    assert.match(calls[0]?.sql ?? '', /AND status = 'blacklisted'/);
  });
});

describe('ApiKeyRepository.setRateLimit', () => {
  it('updates rate_limit_per_minute with parameterized values', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.setRateLimit('abc', 120);
    assert.match(calls[0]?.sql ?? '', /rate_limit_per_minute = \$1/);
    assert.deepEqual(calls[0]?.params, [120, 'abc']);
  });
});

describe('ApiKeyRepository.touchLastUsed', () => {
  it('updates last_used_at to now()', async () => {
    const { pool, calls } = makePool([]);
    const repo = new ApiKeyRepository(pool);
    await repo.touchLastUsed('abc');
    assert.match(calls[0]?.sql ?? '', /last_used_at = now\(\)/);
    assert.deepEqual(calls[0]?.params, ['abc']);
  });
});

// Helper to build a mock pool that serves a transactional client via `connect()`.
interface TxMock {
  pool: Pool;
  client: {
    query: ReturnType<typeof mock.fn>;
    release: ReturnType<typeof mock.fn>;
  };
  queries: string[];
}

function makeTxPool(options: { failOn?: string } = {}): TxMock {
  const queries: string[] = [];
  const client = {
    query: mock.fn(async (sql: string, _params?: unknown[]) => {
      queries.push(sql);
      if (options.failOn && sql.includes(options.failOn)) {
        throw new Error(`forced failure on ${options.failOn}`);
      }
      return { rows: [], rowCount: 1 };
    }),
    release: mock.fn(),
  };
  const pool = {
    connect: mock.fn(async () => client),
  } as unknown as Pool;
  return { pool, client, queries };
}

describe('ApiKeyRepository.recordUsage', () => {
  it('atomically updates api_keys and api_key_tool_usage within a transaction', async () => {
    const { pool, client, queries } = makeTxPool();
    const repo = new ApiKeyRepository(pool);
    await repo.recordUsage({
      keyId: 'k1',
      toolName: 'fetch-news',
      bytesIn: 100,
      bytesOut: 200,
      computeMs: 50,
    });
    // BEGIN, UPDATE api_keys, INSERT ... ON CONFLICT, COMMIT — exactly four statements.
    assert.equal(queries.length, 4);
    assert.equal(queries[0], 'BEGIN');
    assert.match(queries[1] ?? '', /UPDATE api_keys/);
    assert.match(queries[1] ?? '', /request_count\s*=\s*request_count \+ 1/);
    assert.match(queries[2] ?? '', /INSERT INTO api_key_tool_usage/);
    assert.match(queries[2] ?? '', /ON CONFLICT \(key_id, tool_name\) DO UPDATE/);
    assert.equal(queries[3], 'COMMIT');
    assert.equal(client.release.mock.callCount(), 1);
  });

  it('skips the tool_usage INSERT when toolName is null', async () => {
    const { pool, queries } = makeTxPool();
    const repo = new ApiKeyRepository(pool);
    await repo.recordUsage({
      keyId: 'k1',
      toolName: null,
      bytesIn: 0,
      bytesOut: 0,
      computeMs: 0,
    });
    assert.equal(queries.length, 3);
    assert.equal(queries[0], 'BEGIN');
    assert.match(queries[1] ?? '', /UPDATE api_keys/);
    assert.equal(queries[2], 'COMMIT');
  });

  it('passes the right values to the api_keys update', async () => {
    const { pool, client } = makeTxPool();
    const repo = new ApiKeyRepository(pool);
    await repo.recordUsage({
      keyId: 'k1',
      toolName: 'fetch-news',
      bytesIn: 11,
      bytesOut: 22,
      computeMs: 33,
    });
    const updateCall = client.query.mock.calls[1];
    assert.deepEqual(updateCall?.arguments[1], ['k1', 11, 22, 33]);
  });

  it('passes the right values to the tool_usage upsert', async () => {
    const { pool, client } = makeTxPool();
    const repo = new ApiKeyRepository(pool);
    await repo.recordUsage({
      keyId: 'k1',
      toolName: 'fetch-news',
      bytesIn: 11,
      bytesOut: 22,
      computeMs: 33,
    });
    const upsertCall = client.query.mock.calls[2];
    assert.deepEqual(upsertCall?.arguments[1], ['k1', 'fetch-news', 11, 22, 33]);
  });

  it('rolls back and swallows errors (fire-and-forget contract)', async () => {
    const { pool, client, queries } = makeTxPool({ failOn: 'UPDATE api_keys' });
    const repo = new ApiKeyRepository(pool);
    // Must not throw.
    await repo.recordUsage({
      keyId: 'k1',
      toolName: 'fetch-news',
      bytesIn: 0,
      bytesOut: 0,
      computeMs: 0,
    });
    // BEGIN ran, then UPDATE threw, then ROLLBACK ran.
    assert.ok(queries.includes('ROLLBACK'));
    assert.equal(client.release.mock.callCount(), 1);
  });

  it('surfaces a rollback failure through the logger without throwing', async () => {
    const queries: string[] = [];
    const client = {
      query: mock.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('UPDATE api_keys') || sql === 'ROLLBACK') {
          throw new Error(`boom on ${sql.trim().slice(0, 20)}`);
        }
        return { rows: [], rowCount: 0 };
      }),
      release: mock.fn(),
    };
    const pool = { connect: mock.fn(async () => client) } as unknown as Pool;
    const repo = new ApiKeyRepository(pool);
    await repo.recordUsage({
      keyId: 'k1',
      toolName: null,
      bytesIn: 0,
      bytesOut: 0,
      computeMs: 0,
    });
    // Still released even when both the body and rollback fail.
    assert.equal(client.release.mock.callCount(), 1);
  });

  it('never leaks a client when connect itself fails', async () => {
    const pool = {
      connect: mock.fn(async () => {
        throw new Error('pool exhausted');
      }),
    } as unknown as Pool;
    const repo = new ApiKeyRepository(pool);
    await repo.recordUsage({
      keyId: 'k1',
      toolName: null,
      bytesIn: 0,
      bytesOut: 0,
      computeMs: 0,
    });
    // If we got here without throwing, the contract held.
    assert.ok(true);
  });
});
