import { Queue } from 'bullmq';
import { registerShutdown } from '../lib/shutdown.ts';
import { producerConnection } from './_connection.ts';

export interface FetchJobData {
  url: string;
  apiKeyId: string;
}

export interface FetchJobResult {
  resourceId: string;
  statusCode: number;
  bytes: number;
}

export const fetchQueue = new Queue<FetchJobData, FetchJobResult>('fetch', {
  connection: producerConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 86400, count: 1000 },
    removeOnFail: { age: 604800 },
  },
});

registerShutdown('fetch-queue', async () => {
  await fetchQueue.close();
});

export const queues = { fetch: fetchQueue } as const;
export type AppQueues = typeof queues;
