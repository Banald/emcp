import type { Redis } from 'ioredis';
import type { Pool, PoolClient } from 'pg';
import { config } from '../../config.ts';
import { negCacheKey } from '../../core/auth.ts';
import { ConflictError } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { query } from '../client.ts';

export type ApiKeyStatus = 'active' | 'blacklisted' | 'deleted';

export interface ApiKeyRecord {
  id: string;
  keyPrefix: string;
  keyHash: string;
  name: string;
  status: ApiKeyStatus;
  rateLimitPerMinute: number;
  allowNoOrigin: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
  blacklistedAt: Date | null;
  deletedAt: Date | null;
  requestCount: bigint;
  bytesIn: bigint;
  bytesOut: bigint;
  totalComputeMs: bigint;
}

export interface CreateApiKeyInput {
  keyPrefix: string;
  keyHash: string;
  name: string;
  rateLimitPerMinute?: number;
  allowNoOrigin?: boolean;
}

export interface RecordUsageInput {
  keyId: string;
  toolName: string | null;
  bytesIn: number;
  bytesOut: number;
  computeMs: number;
}

export type ListStatusFilter = ApiKeyStatus | 'all';

export interface ListFilter {
  status?: ListStatusFilter;
}

// Raw database row — snake_case column names, BIGINT counters arrive as strings from `pg` by default.
// We convert BIGINT → bigint here (rather than installing a global pg type parser) so the scope of
// the special handling is visible and contained.
interface ApiKeyRow {
  id: string;
  key_prefix: string;
  key_hash: string;
  name: string;
  status: ApiKeyStatus;
  rate_limit_per_minute: number;
  allow_no_origin: boolean;
  created_at: Date;
  last_used_at: Date | null;
  blacklisted_at: Date | null;
  deleted_at: Date | null;
  request_count: string | number | bigint;
  bytes_in: string | number | bigint;
  bytes_out: string | number | bigint;
  total_compute_ms: string | number | bigint;
}

function toBigInt(value: string | number | bigint): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function mapRow(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    name: row.name,
    status: row.status,
    rateLimitPerMinute: row.rate_limit_per_minute,
    allowNoOrigin: row.allow_no_origin,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    blacklistedAt: row.blacklisted_at,
    deletedAt: row.deleted_at,
    requestCount: toBigInt(row.request_count),
    bytesIn: toBigInt(row.bytes_in),
    bytesOut: toBigInt(row.bytes_out),
    totalComputeMs: toBigInt(row.total_compute_ms),
  };
}

const SELECT_COLUMNS = `
  id, key_prefix, key_hash, name, status,
  rate_limit_per_minute, allow_no_origin,
  created_at, last_used_at, blacklisted_at, deleted_at,
  request_count, bytes_in, bytes_out, total_compute_ms
`;

export class ApiKeyRepository {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(input: CreateApiKeyInput, redis?: Redis): Promise<ApiKeyRecord> {
    const rateLimit = input.rateLimitPerMinute ?? config.rateLimitDefaultPerMinute;
    const allowNoOrigin = input.allowNoOrigin ?? false;
    const { rows } = await query<ApiKeyRow>(
      `INSERT INTO api_keys (key_prefix, key_hash, name, rate_limit_per_minute, allow_no_origin)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [input.keyPrefix, input.keyHash, input.name, rateLimit, allowNoOrigin],
      this.pool,
    );
    const row = rows[0];
    if (!row) throw new Error('api key create returned no row');
    // Invalidate any stale negative-cache entry so a brand-new key that
    // happens to match a previously-attempted lookup works on first use
    // (AUDIT H-3). Write errors are swallowed — the cache has a short TTL
    // and this is a correctness belt-and-braces.
    if (redis) {
      redis.del(negCacheKey(input.keyHash)).catch((err) => {
        logger.warn({ err }, 'failed to clear negative cache on key create');
      });
    }
    return mapRow(row);
  }

  async findById(id: string): Promise<ApiKeyRecord | null> {
    const { rows } = await query<ApiKeyRow>(
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE id = $1`,
      [id],
      this.pool,
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async findByPrefix(prefix: string): Promise<ApiKeyRecord | null> {
    const { rows } = await query<ApiKeyRow>(
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_prefix = $1 LIMIT 1`,
      [prefix],
      this.pool,
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  /**
   * Like `findByPrefix`, but throws `ConflictError` if more than one row
   * matches (AUDIT L-4). Used by the CLI's `<id-or-prefix>` resolution so
   * operators never mutate the wrong key when an old short prefix happens
   * to collide with a newer 16-char one.
   */
  async findByPrefixUnique(prefix: string): Promise<ApiKeyRecord | null> {
    const { rows } = await query<ApiKeyRow>(
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_prefix = $1`,
      [prefix],
      this.pool,
    );
    if (rows.length > 1) {
      throw new ConflictError(
        `prefix "${prefix}" matched ${rows.length} keys; use the UUID instead`,
        'Ambiguous prefix; use the UUID instead.',
      );
    }
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  // Primary auth hot path — relies on the UNIQUE index on key_hash.
  async findByHash(keyHash: string): Promise<ApiKeyRecord | null> {
    const { rows } = await query<ApiKeyRow>(
      `SELECT ${SELECT_COLUMNS} FROM api_keys WHERE key_hash = $1`,
      [keyHash],
      this.pool,
    );
    const row = rows[0];
    return row ? mapRow(row) : null;
  }

  async list(filter: ListFilter = {}): Promise<ApiKeyRecord[]> {
    const status = filter.status;
    let sql = `SELECT ${SELECT_COLUMNS} FROM api_keys`;
    const params: unknown[] = [];
    if (status === 'active' || status === 'blacklisted' || status === 'deleted') {
      sql += ' WHERE status = $1';
      params.push(status);
    } else if (status === 'all') {
      // no filter
    } else {
      sql += " WHERE status <> 'deleted'";
    }
    sql += ' ORDER BY created_at DESC';
    const { rows } = await query<ApiKeyRow>(sql, params, this.pool);
    return rows.map(mapRow);
  }

  async blacklist(id: string): Promise<void> {
    await query(
      `UPDATE api_keys SET status = 'blacklisted', blacklisted_at = now() WHERE id = $1`,
      [id],
      this.pool,
    );
  }

  // Guarded: only a currently-blacklisted key can be reactivated. A deleted key is permanent.
  async unblacklist(id: string): Promise<void> {
    await query(
      `UPDATE api_keys SET status = 'active', blacklisted_at = NULL
       WHERE id = $1 AND status = 'blacklisted'`,
      [id],
      this.pool,
    );
  }

  async softDelete(id: string): Promise<void> {
    await query(
      `UPDATE api_keys SET status = 'deleted', deleted_at = now() WHERE id = $1`,
      [id],
      this.pool,
    );
  }

  async setRateLimit(id: string, perMinute: number): Promise<void> {
    await query(
      `UPDATE api_keys SET rate_limit_per_minute = $1 WHERE id = $2`,
      [perMinute, id],
      this.pool,
    );
  }

  async touchLastUsed(id: string): Promise<void> {
    await query(`UPDATE api_keys SET last_used_at = now() WHERE id = $1`, [id], this.pool);
  }

  // Atomically updates the aggregate counters on api_keys AND the per-tool breakdown.
  // Fire-and-forget from the caller's perspective: this method swallows errors via the logger
  // so that a failing metrics write never breaks a successful request.
  async recordUsage(input: RecordUsageInput): Promise<void> {
    let client: PoolClient | null = null;
    try {
      client = await this.pool.connect();
      await client.query('BEGIN');
      await query(
        `UPDATE api_keys
         SET request_count    = request_count + 1,
             bytes_in         = bytes_in + $2,
             bytes_out        = bytes_out + $3,
             total_compute_ms = total_compute_ms + $4,
             last_used_at     = now()
         WHERE id = $1`,
        [input.keyId, input.bytesIn, input.bytesOut, input.computeMs],
        client,
      );
      if (input.toolName !== null) {
        await query(
          `INSERT INTO api_key_tool_usage
             (key_id, tool_name, invocation_count, bytes_in, bytes_out, total_compute_ms, last_used_at)
           VALUES ($1, $2, 1, $3, $4, $5, now())
           ON CONFLICT (key_id, tool_name) DO UPDATE SET
             invocation_count = api_key_tool_usage.invocation_count + 1,
             bytes_in         = api_key_tool_usage.bytes_in + EXCLUDED.bytes_in,
             bytes_out        = api_key_tool_usage.bytes_out + EXCLUDED.bytes_out,
             total_compute_ms = api_key_tool_usage.total_compute_ms + EXCLUDED.total_compute_ms,
             last_used_at     = now()`,
          [input.keyId, input.toolName, input.bytesIn, input.bytesOut, input.computeMs],
          client,
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      if (client !== null) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackErr) {
          logger.warn({ err: rollbackErr, keyId: input.keyId }, 'record usage rollback failed');
        }
      }
      logger.error({ err, keyId: input.keyId, toolName: input.toolName }, 'record usage failed');
    } finally {
      if (client !== null) client.release();
    }
  }
}
