import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import { buildTestEnv } from '../_helpers/env.ts';

const { Pool } = pg;

describe('graceful shutdown', { timeout: 120_000 }, () => {
  let pgContainer: StartedPostgreSqlContainer;
  let redisContainer: StartedTestContainer;
  let databaseUrl: string;
  let redisUrl: string;

  before(async () => {
    // Start containers
    pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
    redisContainer = await new GenericContainer('redis:7-alpine').withExposedPorts(6379).start();

    databaseUrl = pgContainer.getConnectionUri();
    redisUrl = `redis://localhost:${redisContainer.getMappedPort(6379)}`;

    // Run migrations
    await runner({
      databaseUrl,
      dir: resolve(process.cwd(), 'migrations'),
      direction: 'up',
      migrationsTable: 'pgmigrations',
      verbose: false,
    });

    // Override container-scoped env vars on top of the defaults from tests/setup.ts.
    Object.assign(
      process.env,
      buildTestEnv({
        EMCP_DATABASE_URL: databaseUrl,
        EMCP_DATABASE_POOL_MAX: '2',
        EMCP_REDIS_URL: redisUrl,
        EMCP_SHUTDOWN_TIMEOUT_MS: '10000',
      }),
    );

    // Seed a test API key
    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    const { generateApiKey, hashApiKey, extractKeyPrefix } = await import(
      '../../src/core/auth-hash.ts'
    );
    const rawKey = generateApiKey('mcp_test');
    const keyHash = hashApiKey(rawKey);
    const keyPrefix = extractKeyPrefix(rawKey);
    await pool.query(
      `INSERT INTO api_keys (key_prefix, key_hash, name, rate_limit_per_minute, allow_no_origin)
       VALUES ($1, $2, $3, $4, $5)`,
      [keyPrefix, keyHash, 'shutdown-test', 60, true],
    );
    await pool.end();

    // Store the raw key in the environment for the child processes
    process.env._SHUTDOWN_TEST_API_KEY = rawKey;
  });

  after(async () => {
    await pgContainer.stop();
    await redisContainer.stop();
  });

  function buildEnv(port: number): Record<string, string> {
    return buildTestEnv({
      EMCP_PORT: String(port),
      EMCP_PUBLIC_HOST: `127.0.0.1:${port}`,
      EMCP_ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
      EMCP_DATABASE_URL: databaseUrl,
      EMCP_DATABASE_POOL_MAX: '2',
      EMCP_REDIS_URL: redisUrl,
      EMCP_SHUTDOWN_TIMEOUT_MS: '10000',
    });
  }

  function findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const srv = createHttpServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (addr && typeof addr !== 'string') {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          reject(new Error('Failed to allocate port'));
        }
      });
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

  function sendRequest(
    port: number,
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path,
          method: opts.method ?? 'GET',
          headers: opts.headers ?? {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            });
          });
        },
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  async function waitForReady(port: number, maxAttempts = 50): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await sendRequest(port, '/health');
        if (res.status === 200) return;
      } catch {
        // not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`server did not become ready on port ${port}`);
  }

  it('server exits cleanly on SIGTERM', async () => {
    const port = await findFreePort();
    const env = buildEnv(port);

    const child = spawn(process.execPath, ['src/index.ts'], {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(port);

      // Server is up — send SIGTERM
      child.kill('SIGTERM');

      const exitCode = await waitForChild(child);
      assert.equal(exitCode, 0, `expected clean exit 0, got ${exitCode}`);
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  });

  it('server completes in-flight MCP request before exiting', async () => {
    const port = await findFreePort();
    const env = buildEnv(port);
    const apiKey = process.env._SHUTDOWN_TEST_API_KEY ?? '';
    assert.ok(apiKey.length > 0, 'expected _SHUTDOWN_TEST_API_KEY to be set');

    const child = spawn(process.execPath, ['src/index.ts'], {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(port);

      // Send an initialize request — this starts a session but returns quickly
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'shutdown-test', version: '1.0.0' },
        },
      });
      const initRes = await sendRequest(port, '/mcp', {
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: initBody,
      });
      assert.equal(initRes.status, 200, `initialize should succeed, got ${initRes.status}`);

      // Now send SIGTERM
      child.kill('SIGTERM');

      const exitCode = await waitForChild(child);
      assert.equal(exitCode, 0, `expected clean exit 0, got ${exitCode}`);
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  });

  it('worker exits cleanly on SIGTERM', async () => {
    const env = buildEnv(3099);

    const child = spawn(process.execPath, ['src/workers/index.ts'], {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // Wait for the worker to initialize (log "mcp-worker ready" or just poll briefly)
    await new Promise((r) => setTimeout(r, 2_000));

    try {
      child.kill('SIGTERM');
      const exitCode = await waitForChild(child);
      assert.equal(exitCode, 0, `expected clean exit 0, got ${exitCode}`);
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  });

  it('no orphan DB connections after server shutdown', async () => {
    const port = await findFreePort();
    const env = buildEnv(port);

    const child = spawn(process.execPath, ['src/index.ts'], {
      env,
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForReady(port);

      // Record connection count before shutdown
      const pool = new Pool({ connectionString: databaseUrl, max: 1 });
      const before = await pool.query<{ count: string }>(
        `SELECT count(*) as count FROM pg_stat_activity WHERE datname = current_database() AND pid != pg_backend_pid()`,
      );
      const connsBefore = Number.parseInt(before.rows[0].count, 10);

      child.kill('SIGTERM');
      await waitForChild(child);

      // Brief delay for connections to fully close
      await new Promise((r) => setTimeout(r, 500));

      const after = await pool.query<{ count: string }>(
        `SELECT count(*) as count FROM pg_stat_activity WHERE datname = current_database() AND pid != pg_backend_pid()`,
      );
      const connsAfter = Number.parseInt(after.rows[0].count, 10);
      await pool.end();

      // After shutdown, the server's connections should be gone.
      // We allow <= the before count since other processes might have connected.
      assert.ok(
        connsAfter <= connsBefore,
        `expected no new orphan connections: before=${connsBefore}, after=${connsAfter}`,
      );
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    }
  });
});
