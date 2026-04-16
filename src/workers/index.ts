import { Worker } from 'bullmq';
import { config } from '../config.ts';
import { pool } from '../db/client.ts';
import { logger } from '../lib/logger.ts';
import { redis } from '../lib/redis.ts';
import { registerShutdown } from '../lib/shutdown.ts';
import { workerConnection } from './_connection.ts';
import { fetchUrlProcessor } from './processors/fetch-url.ts';

async function main() {
  logger.info('starting mcp-worker');

  const ctx = { logger, db: pool, redis };

  const fetchWorker = new Worker('fetch', async (job) => fetchUrlProcessor(job, ctx), {
    connection: workerConnection,
    concurrency: config.workerConcurrency,
  });

  fetchWorker.on('failed', (job, err) => {
    logger.error({ job_id: job?.id, err }, 'job failed');
  });
  fetchWorker.on('completed', (job) => {
    logger.info({ job_id: job.id }, 'job completed');
  });

  registerShutdown('fetch-worker', async () => {
    await fetchWorker.close();
  });

  logger.info({ concurrency: config.workerConcurrency }, 'mcp-worker ready');
}

main().catch((err) => {
  logger.fatal({ err }, 'worker startup failed');
  setTimeout(() => process.exit(1), 100);
});
