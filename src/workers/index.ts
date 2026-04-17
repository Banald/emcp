import { config } from '../config.ts';
import { pool } from '../db/client.ts';
import { logger } from '../lib/logger.ts';
import { registerShutdown } from '../lib/shutdown.ts';
import { loadWorkers } from '../shared/workers/loader.ts';
import { createScheduler } from '../shared/workers/scheduler.ts';

async function main() {
  logger.info('starting mcp-worker');

  const registry = await loadWorkers(new URL('.', import.meta.url).pathname);
  logger.info({ worker_count: registry.list().length }, 'workers loaded');

  const shutdown = new AbortController();
  const scheduler = createScheduler({
    workers: registry.list(),
    db: pool,
    logger,
    shutdownSignal: shutdown.signal,
  });

  // Register shutdown BEFORE start() so a SIGTERM arriving during startup
  // (including while runOnStartup handlers are still in flight) still drives
  // the scheduler through its stop path.
  registerShutdown('worker-scheduler', async () => {
    shutdown.abort();
    await scheduler.stop(config.shutdownTimeoutMs);
  });

  await scheduler.start();

  logger.info('mcp-worker ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker startup failed');
  setTimeout(() => process.exit(1), 100);
});
