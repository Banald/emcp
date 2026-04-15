import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { ConfigError } from './lib/errors.ts';

const nodeEnvSchema = z.enum(['development', 'production', 'test']);
const logLevelSchema = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']);

const integer = (min: number, max?: number) => {
  const base = z.coerce.number().int().min(min);
  return max === undefined ? base : base.max(max);
};

const csv = z
  .string()
  .min(1)
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  .refine((list) => list.length > 0, 'must contain at least one non-empty value');

const base64Secret = z
  .string()
  .min(1)
  .refine((value) => {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return false;
    return Buffer.from(value, 'base64').length >= 32;
  }, 'must be base64 and decode to at least 32 bytes');

const envSchema = z.object({
  NODE_ENV: nodeEnvSchema,
  PORT: integer(1, 65535),
  BIND_HOST: z.string().min(1).default('127.0.0.1'),
  PUBLIC_HOST: z.string().min(1),
  ALLOWED_ORIGINS: csv,
  DATABASE_URL: z.string().min(1),
  DATABASE_POOL_MAX: integer(1, 1000).default(10),
  REDIS_URL: z.string().min(1),
  API_KEY_HMAC_SECRET: base64Secret,
  LOG_LEVEL: logLevelSchema.optional(),
  RATE_LIMIT_DEFAULT_PER_MINUTE: integer(1).default(60),
  WORKER_CONCURRENCY: integer(1).default(3),
  SHUTDOWN_TIMEOUT_MS: integer(1000).default(30000),
});

export type NodeEnv = z.infer<typeof nodeEnvSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;

export interface Config {
  readonly nodeEnv: NodeEnv;
  readonly port: number;
  readonly bindHost: string;
  readonly publicHost: string;
  readonly allowedOrigins: readonly string[];
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly redisUrl: string;
  readonly apiKeyHmacSecret: string;
  readonly logLevel: LogLevel;
  readonly rateLimitDefaultPerMinute: number;
  readonly workerConcurrency: number;
  readonly shutdownTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
        return `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new ConfigError(`Invalid configuration: ${details}`, 'Server configuration error.');
  }

  const raw = result.data;
  const logLevel: LogLevel = raw.LOG_LEVEL ?? (raw.NODE_ENV === 'development' ? 'debug' : 'info');

  const resolved: Config = {
    nodeEnv: raw.NODE_ENV,
    port: raw.PORT,
    bindHost: raw.BIND_HOST,
    publicHost: raw.PUBLIC_HOST,
    allowedOrigins: Object.freeze([...raw.ALLOWED_ORIGINS]),
    databaseUrl: raw.DATABASE_URL,
    databasePoolMax: raw.DATABASE_POOL_MAX,
    redisUrl: raw.REDIS_URL,
    apiKeyHmacSecret: raw.API_KEY_HMAC_SECRET,
    logLevel,
    rateLimitDefaultPerMinute: raw.RATE_LIMIT_DEFAULT_PER_MINUTE,
    workerConcurrency: raw.WORKER_CONCURRENCY,
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
  };
  return Object.freeze(resolved);
}

export const config: Config = loadConfig(process.env);
