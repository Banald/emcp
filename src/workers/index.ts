import type { Queue } from 'bullmq';
import { Worker } from 'bullmq';
import { config } from '../config.ts';
import { metrics } from '../core/metrics.ts';
import { pool } from '../db/client.ts';
import { logger } from '../lib/logger.ts';
import { redis } from '../lib/redis.ts';
import { registerShutdown } from '../lib/shutdown.ts';
import { workerConnection } from './_connection.ts';
import { fetchUrlProcessor } from './processors/fetch-url.ts';
import { fetchQueue } from './queues.ts';

async function main() {
  logger.info('starting mcp-worker');

  const ctx = { logger, db: pool, redis };

  const fetchWorker = new Worker('fetch', async (job) => fetchUrlProcessor(job, ctx), {
    connection: workerConnection,
    concurrency: config.workerConcurrency,
  });

  fetchWorker.on('completed', (job) => {
    logger.info({ job_id: job.id }, 'job completed');
    metrics.bullmqJobsTotal.inc({ queue: 'fetch', status: 'completed' });
    if (job.processedOn && job.finishedOn) {
      metrics.bullmqJobDuration.observe(
        { queue: 'fetch' },
        (job.finishedOn - job.processedOn) / 1000,
      );
    }
  });

  fetchWorker.on('failed', (job, err) => {
    logger.error({ job_id: job?.id, err }, 'job failed');
    metrics.bullmqJobsTotal.inc({ queue: 'fetch', status: 'failed' });
  });

  // Periodic queue depth polling — updates the gauge every 10s.
  const queuesToPoll: Array<{ name: string; queue: Queue }> = [
    { name: 'fetch', queue: fetchQueue },
  ];

  const depthInterval = setInterval(async () => {
    for (const { name, queue } of queuesToPoll) {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
        for (const [state, count] of Object.entries(counts)) {
          metrics.bullmqQueueDepth.set({ queue: name, state }, count);
        }
      } catch (err) {
        logger.warn({ err, queue: name }, 'failed to poll queue depth');
      }
    }
  }, 10_000);

  registerShutdown('queue-depth-poll', async () => {
    clearInterval(depthInterval);
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
