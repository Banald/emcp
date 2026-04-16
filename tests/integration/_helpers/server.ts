// Integration test harness. Starts a Postgres container via Testcontainers,
// runs migrations, seeds a test API key, boots a real MCP server on an
// ephemeral port, and returns everything needed for end-to-end testing.
//
// First run may take ~10–20 seconds to pull the Postgres Docker image.
// Subsequent runs reuse the cached image and start much faster (~2–5s).

import { createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { runner } from 'node-pg-migrate';
import pg from 'pg';

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
  close: () => Promise<void>;
}

export async function startTestServer(): Promise<TestServer> {
  // 1. Start Postgres container.
  const pgContainer = await new PostgreSqlContainer('postgres:16-alpine').start();
  const databaseUrl = pgContainer.getConnectionUri();

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
  process.env.REDIS_URL = 'redis://placeholder:6379';
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

  // 5. Dynamic imports from src/ — config.ts evaluates here with the correct env.
  const { createServer } = await import('../../../src/server.ts');
  const { ApiKeyRepository } = await import('../../../src/db/repos/api-keys.ts');
  const { generateApiKey, hashApiKey, extractKeyPrefix } = await import(
    '../../../src/core/auth-hash.ts'
  );
  const { loadTools } = await import('../../../src/tools/loader.ts');
  const { createLogger } = await import('../../../src/lib/logger.ts');

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

  // 9. Build the server with real deps (Redis stubbed — not needed for Phase 4 tools).
  const logger = createLogger({ level: 'silent' });
  const { httpServer, close: closeServer } = await createServer({
    pool,
    redis: {} as never, // Phase 5 wires a real Redis container
    repo,
    registry,
    queues: {},
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
    close: async () => {
      await closeServer();
      await pool.end();
      await pgContainer.stop();
    },
  };
}
