// Integration test harness. Starts Postgres and Redis containers via
// Testcontainers, runs migrations, seeds a test API key, boots a real MCP
// server on an ephemeral port, and returns everything needed for end-to-end
// testing.
//
// CRITICAL: All src/ imports are dynamic (await import(...)). Module evaluation
// happens AFTER env vars are set. Static imports would evaluate queues.ts (and
// trigger Redis connection) before REDIS_URL is set, causing connect-refused
// errors. Do not convert these to static imports.
//
// First run may take ~10–20 seconds to pull Docker images.
// Subsequent runs reuse the cached images and start much faster (~2–5s).

import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import type { Redis as RedisType } from 'ioredis';
import { runner } from 'node-pg-migrate';
import type { Pool as PoolType } from 'pg';
import pg from 'pg';
import type { Logger as LoggerType } from 'pino';
import { GenericContainer } from 'testcontainers';

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

export interface WorkerContext {
  readonly logger: LoggerType;
  readonly db: PoolType;
  readonly redis: RedisType;
}

export interface TestServer {
  url: string;
  apiKey: string;
  pool: InstanceType<typeof Pool>;
  redis: RedisType;
  workerConnection: RedisType;
  workerCtx: WorkerContext;
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  // 1. Start containers FIRST — before any src/ imports.
  const pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redisContainer = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withCommand(['redis-server', '--maxmemory-policy', 'noeviction'])
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
  process.env.WORKER_CONCURRENCY = '3';
  process.env.SHUTDOWN_TIMEOUT_MS = '5000';

  // 4. Run migrations against the container.
  await runner({
    databaseUrl,
    dir: path.resolve(process.cwd(), 'migrations'),
    direction: 'up',
    migrationsTable: 'pgmigrations',
    verbose: false,
  });

  // 5. Dynamic imports from src/ — module evaluation happens here, AFTER env is set.
  //    This ordering is NOT optional. See the comment at the top of this file.
  const { createServer } = await import('../../../src/server.ts');
  const { ApiKeyRepository } = await import('../../../src/db/repos/api-keys.ts');
  const { generateApiKey, hashApiKey, extractKeyPrefix } = await import(
    '../../../src/core/auth-hash.ts'
  );
  const { loadTools } = await import('../../../src/tools/loader.ts');
  const { createLogger } = await import('../../../src/lib/logger.ts');
  const redisMod = await import('../../../src/lib/redis.ts');
  const dbClientMod = await import('../../../src/db/client.ts');
  const connectionMod = await import('../../../src/workers/_connection.ts');
  const { workerConnection, producerConnection } = connectionMod;
  const { queues } = await import('../../../src/workers/queues.ts');

  // 6. Create a pg Pool connected to the container (separate from any src/ singleton).
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
  const redis = redisMod.getRedis();
  const { httpServer, close: closeServer } = await createServer({
    pool,
    redis,
    repo,
    registry,
    queues,
    logger,
  });

  // 10. Listen on the pre-allocated port.
  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => resolve());
  });

  const url = `http://${host}:${port}`;
  const workerCtx: WorkerContext = { logger, db: pool, redis };

  return {
    url,
    apiKey: rawKey,
    pool,
    redis,
    workerConnection,
    workerCtx,
    close: async () => {
      await closeServer();
      await queues.fetch.close();
      await pool.end();
      // Also close the module-level pool singleton created by src/db/client.ts
      // (imported as a side effect of src/server.ts).
      await dbClientMod.pool.end();
      redis.disconnect();
      producerConnection.disconnect();
      workerConnection.disconnect();
      await pgContainer.stop();
      await redisContainer.stop();
    },
  };
}
