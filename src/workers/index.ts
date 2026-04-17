// Worker process bootstrap — DO NOT MODIFY as a worker author.
//
// This file wires croner's scheduler to the drop-in workers discovered
// under src/workers/. Worker authors drop a `.ts` file alongside this one
// (see docs/WORKER_AUTHORING.md); the scheduler handles the rest.
//
// Scheduler-/loader-level changes belong in src/shared/workers/ — edit
// scheduler.ts or loader.ts deliberately, not this bootstrap.

import { config } from '../config.ts';
import { pool } from '../db/client.ts';
import { fatalAndExit, logger } from '../lib/logger.ts';
import { installSignalHandlers, registerShutdown, runShutdown } from '../lib/shutdown.ts';
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

installSignalHandlers();

process.on('unhandledRejection', (reason) => {
  setTimeout(() => process.exit(1), 5_000).unref();
  void runShutdown('unhandled-rejection').finally(() =>
    fatalAndExit(reason, 'worker exiting after unhandled rejection'),
  );
});
process.on('uncaughtException', (err) => {
  setTimeout(() => process.exit(1), 5_000).unref();
  void runShutdown('uncaught-exception').finally(() =>
    fatalAndExit(err, 'worker exiting after uncaught exception'),
  );
});

main().catch((err) => fatalAndExit(err, 'worker startup failed'));
