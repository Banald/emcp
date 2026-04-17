// Integration test harness. Starts Postgres and Redis containers via
// Testcontainers, runs migrations, seeds a test API key, boots a real MCP
// server on an ephemeral port, and returns everything needed for end-to-end
// testing.
//
// src/ imports used to be dynamic because src/config.ts evaluates its Zod
// schema at module load time. Now that src/db/client.ts and src/lib/redis.ts
// are both Proxy-backed lazy singletons, a static import only evaluates
// src/config.ts on first config read — long after this file has set every
// required env var. Dynamic imports are no longer necessary.
//
// First run may take ~10–20 seconds to pull Docker images.
// Subsequent runs reuse the cached images and start much faster (~2–5s).

import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Redis, type Redis as RedisType } from 'ioredis';
import { runner } from 'node-pg-migrate';
import pg from 'pg';
import { GenericContainer } from 'testcontainers';
import { extractKeyPrefix, generateApiKey, hashApiKey } from '../../../src/core/auth-hash.ts';
import { __setPoolForTesting } from '../../../src/db/client.ts';
import { ApiKeyRepository } from '../../../src/db/repos/api-keys.ts';
import { createLogger } from '../../../src/lib/logger.ts';
import { REDIS_OPTIONS } from '../../../src/lib/redis.ts';
import { createServer } from '../../../src/server.ts';
import { loadTools } from '../../../src/shared/tools/loader.ts';

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

  // 2. Find a free port so we can set PUBLIC_HOST before importing src/.
  const port = await findFreePort();
  const host = '127.0.0.1';

  // 3. Set env vars BEFORE any src/ import. config.ts evaluates its Zod schema at
  //    module load time and throws if required vars are missing.
  process.env.NODE_ENV = 'test';
  process.env.PORT = String(port);
  process.env.BIND_HOST = host;
  process.env.PUBLIC_HOST = `${host}:${port}`;
  process.env.ALLOWED_ORIGINS = `http://${host}:${port}`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.DATABASE_POOL_MAX = '5';
  process.env.REDIS_URL = redisUrl;
  process.env.API_KEY_HMAC_SECRET = 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==';
  process.env.LOG_LEVEL = 'silent';
  process.env.RATE_LIMIT_DEFAULT_PER_MINUTE = '60';
  process.env.SHUTDOWN_TIMEOUT_MS = '5000';

  // 4. Run migrations against the container.
  await runner({
    databaseUrl,
    dir: path.resolve(process.cwd(), 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });

  // 5. Create a pg Pool connected to the container (separate from the src/
  //    lazy singleton — we pass this one directly into createServer).
  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  // 6. Seed a test API key via the repository.
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

  // 7. Load tools from src/tools/.
  const registry = await loadTools(path.resolve(process.cwd(), 'src/tools'));

  // 8. Build the server with real deps — test-owned Pool and Redis clients
  //    rather than the src-side singletons, so the test harness is not
  //    coupled to config.ts's snapshot of env vars at module load time.
  const logger = createLogger({ level: 'silent' });
  const redis = new Redis(redisUrl, REDIS_OPTIONS);
  const { httpServer, close: closeServer } = await createServer({
    pool,
    redis,
    repo,
    registry,
    logger,
  });

  // 9. Listen on the pre-allocated port.
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
      // Reset the lazy src-side pool singleton rather than `pool.end()`-ing it:
      // the server was built on our own container-scoped pool, so the src
      // singleton may never have been constructed.
      __setPoolForTesting(null);
      redis.disconnect();
      await pgContainer.stop();
      await redisContainer.stop();
    },
  };
}
