import type { RedisOptions } from 'ioredis';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import { config } from '../config.ts';
import { logger } from './logger.ts';
import { registerShutdown } from './shutdown.ts';

export type { Redis };

export const PRODUCER_OPTIONS: RedisOptions = Object.freeze({
  maxRetriesPerRequest: 3,
});

export const WORKER_OPTIONS: RedisOptions = Object.freeze({
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

export const QUIT_FALLBACK_MS = 2_000;

export type RedisFactory = (url: string, options: RedisOptions) => Redis;

const defaultFactory: RedisFactory = (url, options) => new Redis(url, options);

export function attachErrorLogging(
  client: Redis,
  role: 'producer' | 'worker',
  log: Logger = logger,
): void {
  client.on('error', (err: Error) => {
    log.error({ err, role }, 'redis client error');
  });
}

export function gracefulClose(client: Redis, fallbackMs = QUIT_FALLBACK_MS): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      client.disconnect();
      finish();
    }, fallbackMs);
    client
      .quit()
      .then(() => {
        clearTimeout(timer);
        finish();
      })
      .catch(() => {
        clearTimeout(timer);
        client.disconnect();
        finish();
      });
  });
}

export type ShutdownRegistrar = (name: string, handler: () => Promise<void>) => void;

export function registerRedisShutdown(
  name: string,
  client: Redis,
  register: ShutdownRegistrar = registerShutdown,
  fallbackMs: number = QUIT_FALLBACK_MS,
): void {
  register(name, () => gracefulClose(client, fallbackMs));
}

export function createProducerRedis(factory: RedisFactory = defaultFactory): Redis {
  const client = factory(config.redisUrl, PRODUCER_OPTIONS);
  attachErrorLogging(client, 'producer');
  registerRedisShutdown('redis-producer', client);
  return client;
}

export function createWorkerRedis(factory: RedisFactory = defaultFactory): Redis {
  const client = factory(config.redisUrl, WORKER_OPTIONS);
  attachErrorLogging(client, 'worker');
  registerRedisShutdown('redis-worker', client);
  return client;
}

let producerSingleton: Redis | null = null;

export function getRedis(): Redis {
  if (producerSingleton === null) {
    producerSingleton = createProducerRedis();
  }
  return producerSingleton;
}

/** Test-only hook: replace or clear the cached producer singleton. */
export function __setProducerRedisForTesting(client: Redis | null): void {
  producerSingleton = client;
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    const client = getRedis();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
  has(_target, prop) {
    return Reflect.has(getRedis(), prop);
  },
});
