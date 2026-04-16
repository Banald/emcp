// Integration test for the worker process. Spawns src/workers/index.ts against
// a real Postgres container, verifies the drop-in loader discovers the heartbeat
// worker, schedules it, and exits cleanly on SIGTERM.

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';

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
    return {
      NODE_ENV: 'test',
      PORT: '3000',
      BIND_HOST: '127.0.0.1',
      PUBLIC_HOST: '127.0.0.1:3000',
      ALLOWED_ORIGINS: 'http://127.0.0.1:3000',
      DATABASE_URL: databaseUrl,
      DATABASE_POOL_MAX: '2',
      REDIS_URL: 'redis://localhost:6379',
      API_KEY_HMAC_SECRET: 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==',
      LOG_LEVEL: 'info',
      RATE_LIMIT_DEFAULT_PER_MINUTE: '60',
      SHUTDOWN_TIMEOUT_MS: '5000',
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    };
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
      assert.match(stdout, /"worker_count":1/);
      assert.match(stdout, /"worker":"heartbeat"/);
      assert.match(stdout, /"schedule":"\*\/5 \* \* \* \*"/);

      child.kill('SIGTERM');
      const code = await waitForChild(child);
      assert.equal(code, 0, `expected clean exit 0, got ${code}. Output:\n${stdout}`);
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  });
});
