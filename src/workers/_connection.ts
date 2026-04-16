// Shared ioredis connections for BullMQ workers and producers.
// Workers block on BRPOPLPUSH — must use maxRetriesPerRequest: null.
// Producers should fail fast — maxRetriesPerRequest: 3.
// See docs/WORKER_AUTHORING.md for why these MUST be separate connections.

import { createProducerRedis, createWorkerRedis } from '../lib/redis.ts';

export const workerConnection = createWorkerRedis();
export const producerConnection = createProducerRedis();
