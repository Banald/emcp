import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it, mock } from 'node:test';
import { ConflictError, NotFoundError, TransientError, ValidationError } from '../lib/errors.ts';
import {
  attachErrorLogging,
  createPool,
  mapPgError,
  pool,
  query,
  registerPoolShutdown,
} from './client.ts';

class PgError extends Error {
  readonly code: string;
  constructor(code: string, message = 'pg error') {
    super(message);
    this.code = code;
  }
}

describe('createPool', () => {
  it('produces a pg.Pool instance', () => {
    const p = createPool();
    assert.equal(typeof p.query, 'function');
    assert.equal(typeof p.end, 'function');
    assert.equal(typeof p.on, 'function');
    void p.end();
  });
});

describe('attachErrorLogging', () => {
  it('logs pool errors at fatal level', () => {
    const fatal = mock.fn();
    const fakeLog = {
      fatal,
      trace: mock.fn(),
      debug: mock.fn(),
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    } as unknown as Parameters<typeof attachErrorLogging>[1];
    const emitter = new EventEmitter();
    attachErrorLogging(emitter as unknown as ReturnType<typeof createPool>, fakeLog);
    const err = new Error('connection reset');
    emitter.emit('error', err);
    assert.equal(fatal.mock.callCount(), 1);
    const callArgs = fatal.mock.calls[0]?.arguments;
    assert.equal((callArgs?.[0] as { err: Error }).err, err);
    assert.equal(callArgs?.[1], 'postgres pool error');
  });
});

describe('registerPoolShutdown', () => {
  it('registers a handler named postgres-pool with the supplied registrar', () => {
    const register = mock.fn();
    const p = { end: mock.fn(async () => undefined) };
    registerPoolShutdown(p as unknown as ReturnType<typeof createPool>, register);
    assert.equal(register.mock.callCount(), 1);
    assert.equal(register.mock.calls[0]?.arguments[0], 'postgres-pool');
    assert.equal(typeof register.mock.calls[0]?.arguments[1], 'function');
  });

  it('the registered handler ends the pool when run', async () => {
    const register = mock.fn();
    const end = mock.fn(async () => undefined);
    const p = { end };
    registerPoolShutdown(p as unknown as ReturnType<typeof createPool>, register);
    const handler = register.mock.calls[0]?.arguments[1] as () => Promise<void>;
    await handler();
    assert.equal(end.mock.callCount(), 1);
  });
});

describe('query', () => {
  it('forwards sql and params to the executor', async () => {
    const exec = {
      query: mock.fn(async () => ({ rows: [{ id: 1 }], rowCount: 1 })),
    };
    const result = await query<{ id: number }>(
      'SELECT id FROM t WHERE x = $1',
      [42],
      exec as unknown as Parameters<typeof query>[2],
    );
    assert.equal(exec.query.mock.callCount(), 1);
    assert.deepEqual(exec.query.mock.calls[0]?.arguments, ['SELECT id FROM t WHERE x = $1', [42]]);
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(result.rowCount, 1);
  });

  it('defaults params to an empty array when omitted', async () => {
    const exec = {
      query: mock.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    await query('SELECT 1', undefined, exec as unknown as Parameters<typeof query>[2]);
    const args = exec.query.mock.calls[0]?.arguments as unknown as [string, unknown[]];
    assert.deepEqual(args[1], []);
  });

  it('coerces a null rowCount to 0', async () => {
    const exec = {
      query: mock.fn(async () => ({ rows: [], rowCount: null })),
    };
    const result = await query('SELECT 1', [], exec as unknown as Parameters<typeof query>[2]);
    assert.equal(result.rowCount, 0);
  });

  it('rethrows pg errors as mapped AppErrors', async () => {
    const exec = {
      query: mock.fn(async () => {
        throw new PgError('23505', 'duplicate key value');
      }),
    };
    await assert.rejects(
      query('INSERT INTO t VALUES ($1)', [1], exec as unknown as Parameters<typeof query>[2]),
      ConflictError,
    );
  });

  it('uses the default pool when no executor is provided', async () => {
    const stub = mock.method(pool, 'query', async () => ({ rows: [], rowCount: 0 }));
    try {
      const result = await query('SELECT 1');
      assert.deepEqual(result.rows, []);
      assert.equal(stub.mock.callCount(), 1);
    } finally {
      stub.mock.restore();
    }
  });
});

describe('mapPgError', () => {
  const cases: Array<[string, new (...args: string[]) => Error, string]> = [
    ['23505', ConflictError, 'unique violation'],
    ['23503', ConflictError, 'foreign key violation'],
    ['23502', ValidationError, 'not-null violation'],
    ['23514', ValidationError, 'check violation'],
    ['02000', NotFoundError, 'no data'],
    ['08000', TransientError, 'connection_exception'],
    ['08001', TransientError, 'sqlclient_unable_to_establish_sqlconnection'],
    ['08003', TransientError, 'connection_does_not_exist'],
    ['08004', TransientError, 'sqlserver_rejected_establishment_of_sqlconnection'],
    ['08006', TransientError, 'connection_failure'],
    ['08007', TransientError, 'transaction_resolution_unknown'],
    ['57P01', TransientError, 'admin_shutdown'],
    ['57P02', TransientError, 'crash_shutdown'],
    ['57P03', TransientError, 'cannot_connect_now'],
  ];

  for (const [code, Expected, label] of cases) {
    it(`maps SQLSTATE ${code} (${label}) to ${Expected.name}`, () => {
      const mapped = mapPgError(new PgError(code, label));
      assert.ok(mapped instanceof Expected);
    });
  }

  it('leaves unknown pg codes unchanged', () => {
    const original = new PgError('99999', 'weird');
    const mapped = mapPgError(original);
    assert.equal(mapped, original);
  });

  it('wraps non-Error values in a new Error', () => {
    const mapped = mapPgError('not an error object');
    assert.ok(mapped instanceof Error);
    assert.equal(mapped.message, 'not an error object');
  });

  it('passes through plain Error instances without a code', () => {
    const original = new Error('no code');
    const mapped = mapPgError(original);
    assert.equal(mapped, original);
  });
});
