import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { type ParsedCidr, parseCidrList } from './core/client-ip.ts';
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

// Optional CSV: empty/absent input → empty array; non-empty input is split
// and trimmed identically to `csv`. Used for feature-flag style env vars
// (PROXY_URLS, SEARXNG_OUTGOING_PROXIES) where the natural default is
// "feature disabled".
const optionalCsv = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const proxyRotationSchema = z.enum(['round-robin', 'random']);

// Validates a single proxy URL: http(s) only, must have host and port,
// userinfo optional. Refinements run on the parsed URL so edge cases
// (port = 0, empty host after `://`) fail loudly at startup rather than
// at the first request.
const proxyUrlCsv = optionalCsv.superRefine((list, ctx) => {
  for (const raw of list) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: `invalid proxy URL (cannot parse)`,
      });
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({
        code: 'custom',
        message: `proxy URL must use http: or https: (got "${url.protocol}")`,
      });
    }
    if (url.hostname === '') {
      ctx.addIssue({ code: 'custom', message: 'proxy URL is missing a hostname' });
    }
    // WHATWG URL sets `.port` to '' for scheme-default ports
    // (http:80, https:443), so we can't insist on a non-empty value —
    // those URLs are legitimate. When a port IS present, validate its
    // range; malformed ports (e.g. `http://h:99999`) fail `new URL()`
    // above and never reach this branch.
    if (url.port !== '') {
      const n = Number.parseInt(url.port, 10);
      if (!Number.isFinite(n) || n < 1 || n > 65535) {
        ctx.addIssue({
          code: 'custom',
          message: `proxy URL port out of range (got "${url.port}")`,
        });
      }
    }
  }
});

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
  SHUTDOWN_TIMEOUT_MS: integer(1000).default(30000),
  SEARXNG_URL: z
    .string()
    .url()
    .default('http://localhost:8080')
    .transform((u) => u.replace(/\/+$/, '')),
  // MCP HTTP transport tunables. Defaults mirror the file-level constants
  // that used to live in src/server.ts; bounds prevent pathological values
  // at startup rather than at the first request.
  MCP_MAX_BODY_BYTES: integer(1024, 16 * 1024 * 1024).default(1_048_576),
  MCP_SESSION_IDLE_MS: integer(60_000, 24 * 60 * 60 * 1000).default(30 * 60_000),
  MCP_SESSION_CLEANUP_INTERVAL_MS: integer(1_000, 10 * 60_000).default(60_000),
  MCP_TOOL_CALL_TIMEOUT_MS: integer(1_000, 10 * 60_000).default(30_000),
  // Session cap (AUDIT M-1). Prevents one key from parking unbounded
  // sessions and exhausting server memory. Global cap is a backstop.
  MCP_MAX_SESSIONS_PER_KEY: integer(1, 10_000).default(32),
  MCP_MAX_SESSIONS_TOTAL: integer(1, 1_000_000).default(10_000),
  // Request-receipt timeout (AUDIT L-5). Node's default is 300s, which
  // lets slowloris-style attackers hold sockets open for 5 minutes per
  // request. Applies to headers+body only — SSE streams are unaffected
  // because their response phase sits outside this budget.
  HTTP_REQUEST_TIMEOUT_MS: integer(10_000, 300_000).default(60_000),
  // Pre-auth defences (AUDIT H-3). `PRE_AUTH_RATE_LIMIT_PER_MINUTE` caps
  // how fast *any* peer can burn through failed lookups; the bucket is
  // keyed on the resolved client IP (see `TRUSTED_PROXY_CIDRS` for XFF
  // handling). `AUTH_NEG_CACHE_TTL_SECONDS` short-circuits repeated bad
  // tokens in Redis before they reach Postgres.
  PRE_AUTH_RATE_LIMIT_PER_MINUTE: integer(1).default(600),
  AUTH_NEG_CACHE_TTL_SECONDS: integer(1, 3600).default(60),
  TRUSTED_PROXY_CIDRS: z.string().min(1).default('127.0.0.0/8,::1/128'),
  // Outbound proxy rotation (docs/ARCHITECTURE.md "Proxy egress").
  // Empty PROXY_URLS keeps the feature disabled — no ProxyAgents are
  // created, no dispatcher is threaded through global fetch, and every
  // external call behaves exactly as it did pre-feature.
  PROXY_URLS: proxyUrlCsv,
  PROXY_ROTATION: proxyRotationSchema.default('round-robin'),
  PROXY_FAILURE_COOLDOWN_MS: integer(1_000, 3_600_000).default(60_000),
  PROXY_MAX_RETRIES_PER_REQUEST: integer(1, 10).default(3),
  PROXY_CONNECT_TIMEOUT_MS: integer(1_000, 60_000).default(10_000),
});

export type NodeEnv = z.infer<typeof nodeEnvSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type ProxyRotation = z.infer<typeof proxyRotationSchema>;

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
  readonly shutdownTimeoutMs: number;
  readonly searxngUrl: string;
  readonly mcpMaxBodyBytes: number;
  readonly mcpSessionIdleMs: number;
  readonly mcpSessionCleanupIntervalMs: number;
  readonly mcpToolCallTimeoutMs: number;
  readonly mcpMaxSessionsPerKey: number;
  readonly mcpMaxSessionsTotal: number;
  readonly httpRequestTimeoutMs: number;
  readonly preAuthRateLimitPerMinute: number;
  readonly authNegCacheTtlSeconds: number;
  readonly trustedProxyCidrs: readonly ParsedCidr[];
  readonly proxyUrls: readonly string[];
  readonly proxyRotation: ProxyRotation;
  readonly proxyFailureCooldownMs: number;
  readonly proxyMaxRetriesPerRequest: number;
  readonly proxyConnectTimeoutMs: number;
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

  let trustedProxyCidrs: readonly ParsedCidr[];
  try {
    trustedProxyCidrs = parseCidrList(raw.TRUSTED_PROXY_CIDRS);
  } catch (err) {
    throw new ConfigError(
      `Invalid TRUSTED_PROXY_CIDRS: ${(err as Error).message}`,
      'Server configuration error.',
    );
  }

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
    shutdownTimeoutMs: raw.SHUTDOWN_TIMEOUT_MS,
    searxngUrl: raw.SEARXNG_URL,
    mcpMaxBodyBytes: raw.MCP_MAX_BODY_BYTES,
    mcpSessionIdleMs: raw.MCP_SESSION_IDLE_MS,
    mcpSessionCleanupIntervalMs: raw.MCP_SESSION_CLEANUP_INTERVAL_MS,
    mcpToolCallTimeoutMs: raw.MCP_TOOL_CALL_TIMEOUT_MS,
    mcpMaxSessionsPerKey: raw.MCP_MAX_SESSIONS_PER_KEY,
    mcpMaxSessionsTotal: raw.MCP_MAX_SESSIONS_TOTAL,
    httpRequestTimeoutMs: raw.HTTP_REQUEST_TIMEOUT_MS,
    preAuthRateLimitPerMinute: raw.PRE_AUTH_RATE_LIMIT_PER_MINUTE,
    authNegCacheTtlSeconds: raw.AUTH_NEG_CACHE_TTL_SECONDS,
    trustedProxyCidrs,
    proxyUrls: Object.freeze([...raw.PROXY_URLS]),
    proxyRotation: raw.PROXY_ROTATION,
    proxyFailureCooldownMs: raw.PROXY_FAILURE_COOLDOWN_MS,
    proxyMaxRetriesPerRequest: raw.PROXY_MAX_RETRIES_PER_REQUEST,
    proxyConnectTimeoutMs: raw.PROXY_CONNECT_TIMEOUT_MS,
  };
  return Object.freeze(resolved);
}

export const config: Config = loadConfig(process.env);
