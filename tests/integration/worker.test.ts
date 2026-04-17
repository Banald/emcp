// Integration test for the worker process. Spawns src/workers/index.ts against
// a real Postgres container, verifies the drop-in loader discovers every worker
// under src/workers/, schedules them, and exits cleanly on SIGTERM.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import { buildTestEnv } from '../_helpers/env.ts';

describe('worker process', { timeout: 120_000 }, () => {
  let pgContainer: StartedPostgreSqlContainer;
  let databaseUrl: string;

  before(async () => {
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    databaseUrl = pgContainer.getConnectionUri();
    await runner({
      databaseUrl,
      dir: resolve(process.cwd(), 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });
  });

  after(async () => {
    await pgContainer.stop();
  });

  function buildEnv(): Record<string, string> {
    // NODE_ENV=production (not 'test'): the logger forces level=silent in test
    // mode, which hides the startup logs this test asserts on. Production mode
    // writes JSON to stdout synchronously via pino with no transport — exactly
    // what we need for log-based assertions.
    return buildTestEnv({
      NODE_ENV: 'production',
      PUBLIC_HOST: '127.0.0.1:3000',
      ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: '2',
      LOG_LEVEL: 'info',
    });
  }

  function waitForChild(child: ChildProcess, timeoutMs = 20_000): Promise<number | null> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not exit in time')), timeoutMs);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
  }

  it('discovers workers, schedules them, and exits cleanly on SIGTERM', async () => {
    const child = spawn(process.execPath, ['src/workers/index.ts'], {
      env: buildEnv(),
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    child.stdout?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });
    child.stderr?.on('data', (c: Buffer) => {
      stdout += c.toString('utf-8');
    });

    // Wait up to 15s for the 'mcp-worker ready' log.
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 15_000);
      const check = () => {
        if (stdout.includes('mcp-worker ready')) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      child.stdout?.on('data', check);
      child.stderr?.on('data', check);
    });

    try {
      assert.ok(ready, `worker did not become ready. Output:\n${stdout}`);
      // Exact-count assertion: any worker added or removed under src/workers/
      // must be reflected here deliberately. Keep this list in sync with the
      // drop-in files on disk.
      assert.match(stdout, /"worker_count":2/);
      assert.match(
        stdout,
        /"worker":"heartbeat","schedule":"\*\/5 \* \* \* \*","timezone":"UTC","msg":"worker_scheduled"/,
      );
      assert.match(
        stdout,
        /"worker":"fetch-news","schedule":"0 \*\/2 \* \* \*","timezone":"UTC","msg":"worker_scheduled"/,
      );

      child.kill('SIGTERM');
      const code = await waitForChild(child);
      assert.equal(code, 0, `expected clean exit 0, got ${code}. Output:\n${stdout}`);
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  });
});
