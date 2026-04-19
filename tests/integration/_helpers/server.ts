// Integration test harness. Starts Postgres and Redis containers via
// Testcontainers, runs migrations, seeds a test API key, boots a real MCP
// server on an ephemeral port, and returns everything needed for end-to-end
// testing.
//
// CRITICAL: src/ imports are dynamic. src/config.ts evaluates its Zod schema
// at module load time, and the server's header-validation path reads
// `config.publicHost` — which must hold the container-scoped host:port, not
// the tests/setup.ts defaults. Dynamic imports defer src/config.ts evaluation
// until AFTER this function has overridden the env. Do not convert these to
// static imports without also making src/config.ts lazy.
//
// First run may take ~10–20 seconds to pull Docker images.
// Subsequent runs reuse the cached images and start much faster (~2–5s).

import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Redis as RedisType } from 'ioredis';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { GenericContainer } from 'testcontainers';
import { buildTestEnv } from '../../_helpers/env.ts';

const { Pool } = pg;

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr !== 'string') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error('Failed to allocate ephemeral port'));
      }
    });
  });
}

export interface TestServer {
  url: string;
  apiKey: string;
  pool: InstanceType<typeof Pool>;
  redis: RedisType;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  // 1. Start containers FIRST — before any src/ imports.
  const pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .start();

  const databaseUrl = pgContainer.getConnectionUri();
  const redisUrl = `redis://localhost:${redisContainer.getMappedPort(6379)}`;

  // 2. Find a free port so we can set EMCP_PUBLIC_HOST before importing src/.
  const port = await findFreePort();
  const host = '127.0.0.1';

  // 3. Override the container-scoped env vars on top of the defaults from
  //    tests/setup.ts. The dynamic imports below evaluate src/config.ts
  //    AFTER this assignment, so config reads these values.
  Object.assign(
    process.env,
    buildTestEnv({
      EMCP_PORT: String(port),
      EMCP_BIND_HOST: host,
      EMCP_PUBLIC_HOST: `${host}:${port}`,
      EMCP_ALLOWED_ORIGINS: `http://${host}:${port}`,
      EMCP_DATABASE_URL: databaseUrl,
      EMCP_REDIS_URL: redisUrl,
    }),
  );

  // 4. Run migrations against the container.
  await runner({
    databaseUrl,
    dir: path.resolve(process.cwd(), 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });

  // 5. Dynamic imports from src/ — module evaluation happens here, AFTER env
  //    is overridden. This ordering is NOT optional. See the comment at the
  //    top of this file.
  const { createServer } = await import('../../../src/server.ts');
  const { ApiKeyRepository } = await import('../../../src/db/repos/api-keys.ts');
  const { generateApiKey, hashApiKey, extractKeyPrefix } = await import(
    '../../../src/core/auth-hash.ts'
  );
  const { loadTools } = await import('../../../src/shared/tools/loader.ts');
  const { createLogger } = await import('../../../src/lib/logger.ts');
  const { getRedis } = await import('../../../src/lib/redis.ts');
  const { __setPoolForTesting } = await import('../../../src/db/client.ts');

  // 6. Create a pg Pool connected to the container (separate from the src
  //    lazy singleton — we pass this one directly into createServer).
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  // 7. Seed a test API key via the repository.
  const repo = new ApiKeyRepository(pool);
  const rawKey = generateApiKey('mcp_test');
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);
  await repo.create({
    keyPrefix,
    keyHash,
    name: 'integration test key',
    rateLimitPerMinute: 60,
    allowNoOrigin: true,
  });

  // 8. Load tools from src/tools/.
  const registry = await loadTools(path.resolve(process.cwd(), 'src/tools'));

  // 9. Build the server with real deps — Redis is now a real container.
  const logger = createLogger({ level: 'silent' });
  const redis = getRedis();
  const { httpServer, close: closeServer } = await createServer({
    pool,
    redis,
    repo,
    registry,
    logger,
  });

  // 10. Listen on the pre-allocated port.
  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  const url = `http://${host}:${port}`;

  return {
    url,
    apiKey: rawKey,
    pool,
    redis,
    close: async () => {
      await closeServer();
      await pool.end();
      // Reset the lazy src-side pool singleton rather than `pool.end()`-ing
      // it: the server was built on our own container-scoped pool, so the
      // src singleton may never have been constructed.
      __setPoolForTesting(null);
      redis.disconnect();
      await pgContainer.stop();
      await redisContainer.stop();
    },
  };
}
