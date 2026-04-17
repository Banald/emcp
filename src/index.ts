import { config } from './config.ts';
import { pool } from './db/client.ts';
import { ApiKeyRepository } from './db/repos/api-keys.ts';
import { fatalAndExit, logger } from './lib/logger.ts';
import { redis } from './lib/redis.ts';
import { installSignalHandlers, runShutdown } from './lib/shutdown.ts';
import { createServer } from './server.ts';
import { loadTools } from './shared/tools/loader.ts';

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
    logger,
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.bindHost, () => resolve());
  });
  logger.info({ port: config.port, bind: config.bindHost }, 'mcp-server listening');
}

installSignalHandlers();

// The 5s exit floor only fires if something else keeps the loop alive; it is
// load-bearing when a shutdown handler wedges (pool.end / redis.quit each
// register their own timers that are NOT unref'ed). The unref here prevents
// the floor itself from blocking a clean exit.
process.on('unhandledRejection', (reason) => {
  setTimeout(() => process.exit(1), 5_000).unref();
  void runShutdown('unhandled-rejection').finally(() =>
    fatalAndExit(reason, 'exiting after unhandled rejection'),
  );
});
process.on('uncaughtException', (err) => {
  setTimeout(() => process.exit(1), 5_000).unref();
  void runShutdown('uncaught-exception').finally(() =>
    fatalAndExit(err, 'exiting after uncaught exception'),
  );
});

main().catch((err) => fatalAndExit(err, 'startup failed'));
