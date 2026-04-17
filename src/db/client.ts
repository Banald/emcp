import type { Pool as PgPool, QueryResult, QueryResultRow } from 'pg';
import pg from 'pg';
import type { Logger } from 'pino';
import { config } from '../config.ts';
import { ConflictError, NotFoundError, TransientError, ValidationError } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { registerShutdown } from '../lib/shutdown.ts';

const { Pool } = pg;

export type Pool = PgPool;

export function createPool(): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export function attachErrorLogging(p: Pool, log: Logger = logger): void {
  p.on('error', (err: Error) => {
    log.fatal({ err }, 'postgres pool error');
  });
}

export type ShutdownRegistrar = (name: string, handler: () => Promise<void>) => void;

export function registerPoolShutdown(
  p: Pool,
  register: ShutdownRegistrar = registerShutdown,
): void {
  register('postgres-pool', async () => {
    await p.end();
  });
}

let poolSingleton: Pool | null = null;

export function getPool(): Pool {
  if (poolSingleton === null) {
    poolSingleton = createPool();
    attachErrorLogging(poolSingleton);
    // First-use registration. The pool is always touched before shutdown, so
    // registering here is safe in both the server and CLI paths.
    registerPoolShutdown(poolSingleton);
  }
  return poolSingleton;
}

/** Test-only hook: replace or clear the cached singleton. */
export function __setPoolForTesting(p: Pool | null): void {
  poolSingleton = p;
}

export const pool: Pool = new Proxy({} as Pool, {
  get(_target, prop, receiver) {
    const p = getPool();
    const value = Reflect.get(p, prop, receiver);
    return typeof value === 'function' ? value.bind(p) : value;
  },
  has(_target, prop) {
    return Reflect.has(getPool(), prop);
  },
});

export interface QueryResultShape<T> {
  rows: T[];
  rowCount: number;
}

export type QueryExecutor = Pick<Pool, 'query'>;

export async function query<T extends QueryResultRow>(
  sql: string,
  params: ReadonlyArray<unknown> = [],
  executor: QueryExecutor = pool,
): Promise<QueryResultShape<T>> {
  try {
    const result = (await executor.query<T>(sql, params as unknown[])) as QueryResult<T>;
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  } catch (err) {
    throw mapPgError(err);
  }
}

// https://www.postgresql.org/docs/current/errcodes-appendix.html
export function mapPgError(err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return err;
  const message = err.message;
  switch (code) {
    case '23505':
      return new ConflictError(message, 'Resource already exists.');
    case '23503':
      return new ConflictError(message, 'Referenced resource missing.');
    case '23502':
    case '23514':
      return new ValidationError(message, 'Invalid input.');
    case '02000':
      return new NotFoundError(message, 'Resource not found.');
    case '08000':
    case '08001':
    case '08003':
    case '08004':
    case '08006':
    case '08007':
    case '57P01':
    case '57P02':
    case '57P03':
      return new TransientError(message, 'Database temporarily unavailable.');
    default:
      return err;
  }
}
