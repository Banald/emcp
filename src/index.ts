import { config } from './config.ts';
import { pool } from './db/client.ts';
import { ApiKeyRepository } from './db/repos/api-keys.ts';
import { logger } from './lib/logger.ts';
import { redis } from './lib/redis.ts';
import { createServer } from './server.ts';
import { loadTools } from './tools/loader.ts';
import { queues } from './workers/queues.ts';

async function main() {
  logger.info({ node_env: config.nodeEnv, port: config.port }, 'starting mcp-server');

  if (config.nodeEnv === 'production' && config.bindHost === '0.0.0.0') {
    logger.warn('BIND_HOST is 0.0.0.0 in production — only safe behind a reverse proxy');
  }

  const registry = await loadTools(new URL('./tools', import.meta.url).pathname);
  logger.info({ tool_count: registry.list().length }, 'tools loaded');

  const repo = new ApiKeyRepository(pool);
  const { httpServer } = await createServer({
    pool,
    redis,
    repo,
    registry,
    queues,
    logger,
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.bindHost, () => resolve());
  });
  logger.info({ port: config.port, bind: config.bindHost }, 'mcp-server listening');
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  // Allow logger to flush
  setTimeout(() => process.exit(1), 100);
});

// Signal handlers already registered by src/lib/shutdown.ts (Phase 1)
