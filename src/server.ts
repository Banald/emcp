import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult as SdkCallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { config } from './config.ts';
import { type AuthenticatedKey, authenticate } from './core/auth.ts';
import { getClientIp } from './core/client-ip.ts';
import { buildToolContext } from './core/context.ts';
import { validateHeaders } from './core/headers.ts';
import { metrics, register } from './core/metrics.ts';
import { createRateLimiter, type RateLimiter, type RateLimitResult } from './core/rate-limiter.ts';
import type { ApiKeyRepository } from './db/repos/api-keys.ts';
import { auditAuthFail, auditRateLimitHit, auditToolCall } from './lib/audit.ts';
import {
  type AppError,
  isAppError,
  OriginOrHostRejectedError,
  RateLimitError,
  SessionNotFoundError,
  TransientError,
} from './lib/errors.ts';
import { registerShutdown } from './lib/shutdown.ts';
import type { ToolRegistry } from './shared/tools/loader.ts';

const PKG_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;

export const EXPECTED_HEALTH_CHECKS = ['db', 'redis'] as const;

export function computeHealthAllOk(
  checks: Record<string, { status: string } | undefined>,
): boolean {
  return EXPECTED_HEALTH_CHECKS.every((k) => checks[k]?.status === 'ok');
}

interface Session {
  transport: StreamableHTTPServerTransport;
  mcpServer: McpServer;
  apiKeyId: string;
  lastActivityMs: number;
}

interface ServerDeps {
  pool: Pool;
  redis: Redis;
  repo: ApiKeyRepository;
  registry: ToolRegistry;
  logger: Logger;
}

export async function createServer(
  deps: ServerDeps,
): Promise<{ httpServer: Server; close: () => Promise<void> }> {
  const { pool, redis, repo, registry, logger: log } = deps;
  const rateLimiter = createRateLimiter(redis);
  const sessions = new Map<string, Session>();

  // Request-scoped shutdown signal: combined into every ctx.signal below so a
  // SIGTERM aborts in-flight tool handlers that honor ctx.signal, instead of
  // letting them block shutdown up to their per-call timeout.
  const shutdownCtrl = new AbortController();
  registerShutdown('tool-abort', async () => {
    shutdownCtrl.abort(new Error('server shutting down'));
  });

  /** Idempotent session removal — safe to call multiple times for the same id. */
  const removeSession = async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    metrics.activeSessions.dec();
    try {
      await session.mcpServer.close();
    } catch {
      /* already closed */
    }
  };

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, session] of sessions) {
      if (now - session.lastActivityMs > config.mcpSessionIdleMs) {
        log.info({ sessionId }, 'evicting idle session');
        void removeSession(sessionId);
      }
    }
  }, config.mcpSessionCleanupIntervalMs);
  cleanupInterval.unref();

  const httpServer = createHttpServer(async (req, res) => {
    try {
      await handleRequest(req, res, {
        pool,
        redis,
        repo,
        registry,
        log,
        rateLimiter,
        sessions,
        removeSession,
        shutdownSignal: shutdownCtrl.signal,
      });
    } catch (err) {
      log.error({ err }, 'unhandled request error');
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal error' },
            id: null,
          }),
        );
      }
    }
  });

  // Tighten the request-receipt budget (AUDIT L-5). Node defaults to 300s
  // — a slow-loris attacker could hold sockets open that long. Applies
  // only to the request phase (headers + body); SSE streams fire after
  // that phase ends and so are unaffected. `headersTimeout`,
  // `keepAliveTimeout`, and `maxRequestsPerSocket` stay at their Node
  // defaults (60s / 5s / unlimited) — tuning them has a worse
  // risk/benefit trade for this workload.
  httpServer.requestTimeout = config.httpRequestTimeoutMs;
  // Default checking interval is 30s, which means a timed-out request
  // can linger up to `requestTimeout + 30s` before being closed. Cap
  // the lag at ~5s (or a quarter of the timeout, whichever is smaller)
  // so enforcement tracks the configured budget closely. The type
  // assertion is because `connectionsCheckingInterval` was added in
  // Node 17.12 but is not yet reflected in `@types/node` at the
  // version we're pinned to.
  (httpServer as Server & { connectionsCheckingInterval: number }).connectionsCheckingInterval =
    Math.max(1000, Math.min(5000, Math.floor(config.httpRequestTimeoutMs / 4)));

  const close = async () => {
    clearInterval(cleanupInterval);
    const promises: Promise<void>[] = [];
    for (const [sessionId] of sessions) {
      promises.push(removeSession(sessionId));
    }
    await Promise.all(promises);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  registerShutdown('http-server', close);

  return { httpServer, close };
}

interface HandlerDeps {
  pool: Pool;
  redis: Redis;
  repo: ApiKeyRepository;
  registry: ToolRegistry;
  log: Logger;
  rateLimiter: RateLimiter;
  sessions: Map<string, Session>;
  removeSession: (sessionId: string) => Promise<void>;
  shutdownSignal: AbortSignal;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (url === '/health' && method === 'GET') {
    return handleHealth(req, res, deps);
  }

  if (url === '/metrics' && method === 'GET') {
    return handleMetrics(req, res);
  }

  if (url === '/mcp') {
    return handleMcp(req, res, deps);
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
}

function isLoopback(req: IncomingMessage): boolean {
  const addr = req.socket.localAddress;
  if (addr === undefined) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function applyRateLimitHeaders(res: ServerResponse, result: RateLimitResult): void {
  res.setHeader('X-RateLimit-Limit', String(result.limit));
  res.setHeader('X-RateLimit-Remaining', String(result.remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(result.resetAtMs / 1000)));
}

function categorizeToolError(err: unknown): string {
  if (err instanceof RateLimitError) return 'rate_limit';
  if (err instanceof TransientError) return 'transient';
  if (isAppError(err)) return (err as AppError).name;
  return 'unknown';
}

export function writeJsonRpcError(res: ServerResponse, err: AppError): void {
  res.writeHead(err.httpStatus, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: err.jsonRpcCode, message: err.publicMessage },
      id: null,
    }),
  );
}

async function handleHealth(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};

  // DB check with 1s timeout
  try {
    const t = Date.now();
    await Promise.race([
      deps.pool.query('SELECT 1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000)),
    ]);
    checks.db = { status: 'ok', latency_ms: Date.now() - t };
  } catch (err) {
    checks.db = { status: 'fail', error: (err as Error).message };
  }

  // Redis check with 1s timeout
  try {
    const t = Date.now();
    await Promise.race([
      deps.redis.ping(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1000)),
    ]);
    checks.redis = { status: 'ok', latency_ms: Date.now() - t };
  } catch (err) {
    checks.redis = { status: 'fail', error: (err as Error).message };
  }

  const allOk = computeHealthAllOk(checks);
  const body = {
    status: allOk ? 'ok' : 'fail',
    version: PKG_VERSION,
    uptime_s: Math.floor(process.uptime()),
    checks,
  };

  res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleMetrics(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
}

type AuthReasonLabel = 'missing' | 'malformed' | 'unknown' | 'blacklisted' | 'deleted';

// Map auth error reasons to bounded metric / audit labels.
function authReasonLabel(error: { jsonRpcCode: number }): AuthReasonLabel {
  switch (error.jsonRpcCode) {
    case -32001:
      return 'missing';
    case -32002:
      return 'malformed';
    case -32003:
      return 'unknown';
    case -32004:
      return 'blacklisted';
    case -32005:
      return 'deleted';
    default:
      return 'unknown';
  }
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const { pool, redis, repo, registry, log, rateLimiter, sessions, removeSession, shutdownSignal } =
    deps;
  const method = req.method ?? 'GET';

  // Step 1: Validate headers (Origin/Host) — initial check without per-key origin requirement.
  const headerResult = validateHeaders(
    req.headers as Record<string, string | string[] | undefined>,
    {
      expectedHost: config.publicHost,
      allowedOrigins: config.allowedOrigins,
      requireOrigin: false,
    },
  );

  if (!headerResult.ok) {
    log.warn({ reason: headerResult.reason }, 'header validation failed');
    writeJsonRpcError(res, new OriginOrHostRejectedError(headerResult.reason, 'Forbidden'));
    return;
  }

  // Step 1b: Pre-auth per-IP rate limit (AUDIT H-3). Prevents a flood of
  // unauthenticated requests from saturating Postgres via `findByHash`.
  // Deliberately does NOT set `X-RateLimit-*` — those headers are
  // documented as post-auth-only (SECURITY Rule 7).
  const clientIp = getClientIp(req, config.trustedProxyCidrs);
  const ipRl = await rateLimiter.check({
    scope: `rl:ip:${clientIp}`,
    limit: config.preAuthRateLimitPerMinute,
    windowMs: 60_000,
  });
  if (!ipRl.allowed) {
    metrics.rateLimitHitsTotal.inc({ scope: 'pre_auth_ip' });
    log.warn({ client_ip: clientIp }, 'pre-auth rate limit exceeded');
    res.setHeader('Retry-After', String(ipRl.retryAfterSec));
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32029, message: 'Too many requests' },
        id: null,
      }),
    );
    return;
  }

  // Step 2: Authenticate. Redis backs the negative-lookup cache that
  // short-circuits repeat unknown-key attempts before they reach the DB.
  const authHeader = req.headers.authorization;
  const authResult = await authenticate(authHeader, {
    repo,
    redis,
    negCacheTtlSec: config.authNegCacheTtlSeconds,
  });

  if (!authResult.ok) {
    const err = authResult.error;
    const reasonLabel = authReasonLabel(err);
    metrics.authFailuresTotal.inc({ reason: reasonLabel });
    log.warn({ reason: err.message, code: err.jsonRpcCode }, 'auth failed');
    auditAuthFail({ reason: reasonLabel, jsonRpcCode: err.jsonRpcCode });
    res.writeHead(err.httpStatus, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: err.jsonRpcCode, message: err.publicMessage },
        id: null,
      }),
    );
    return;
  }

  const apiKey = authResult.key;

  // Step 3: Re-validate headers with per-key origin requirement.
  const headerResult2 = validateHeaders(
    req.headers as Record<string, string | string[] | undefined>,
    {
      expectedHost: config.publicHost,
      allowedOrigins: config.allowedOrigins,
      requireOrigin: !apiKey.allowNoOrigin,
    },
  );

  if (!headerResult2.ok) {
    log.warn(
      { reason: headerResult2.reason, api_key_prefix: apiKey.prefix },
      'per-key header validation failed',
    );
    writeJsonRpcError(res, new OriginOrHostRejectedError(headerResult2.reason, 'Forbidden'));
    return;
  }

  // Step 4: Per-key rate limiting.
  const rlResult = await rateLimiter.check({
    scope: `rl:key:${apiKey.id}`,
    limit: apiKey.rateLimitPerMinute,
    windowMs: 60_000,
  });
  applyRateLimitHeaders(res, rlResult);
  if (!rlResult.allowed) {
    metrics.rateLimitHitsTotal.inc({ scope: 'per_key' });
    auditRateLimitHit({ keyId: apiKey.id, keyPrefix: apiKey.prefix, scope: 'per_key' });
    res.setHeader('Retry-After', String(rlResult.retryAfterSec));
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32029, message: 'rate limit exceeded' },
        id: null,
      }),
    );
    return;
  }

  // Step 5: Session routing.
  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  // For POSTs, read + parse the body upfront so the per-tool rate limit
  // (AUDIT L-3) can run at the HTTP layer — headers and `Retry-After`
  // flow through unchanged, and the MCP SDK is never asked to process a
  // request we've already decided to throttle.
  let postBody: Buffer | null = null;
  let postPayload: unknown = null;
  if (method === 'POST') {
    try {
      postBody = await readBody(req, config.mcpMaxBodyBytes);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }
    postPayload = parseJsonRpcBody(res, postBody);
    if (postPayload === null) return;

    // Peek for `tools/call` and a configured per-tool rate limit.
    const peek = postPayload as { id?: unknown; method?: unknown; params?: { name?: unknown } };
    if (peek.method === 'tools/call' && typeof peek.params?.name === 'string') {
      const toolName = peek.params.name;
      const tool = registry.get(toolName);
      if (tool?.rateLimit) {
        const toolRl = await rateLimiter.check({
          scope: `rl:tool:${apiKey.id}:${toolName}`,
          limit: tool.rateLimit.perMinute,
          windowMs: 60_000,
        });
        applyRateLimitHeaders(res, toolRl);
        if (!toolRl.allowed) {
          metrics.rateLimitHitsTotal.inc({ scope: 'per_tool' });
          metrics.requestsTotal.inc({ tool: toolName, status: 'rate_limited' });
          auditRateLimitHit({
            keyId: apiKey.id,
            keyPrefix: apiKey.prefix,
            scope: 'per_tool',
            tool: toolName,
          });
          res.setHeader('Retry-After', String(toolRl.retryAfterSec));
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              error: { code: -32029, message: `rate limit exceeded for ${toolName}` },
              id: peek.id ?? null,
            }),
          );
          return;
        }
      }
    }
  }

  if (sessionId) {
    // --- Existing session ---
    const session = sessions.get(sessionId);
    if (!session) {
      writeJsonRpcError(res, new SessionNotFoundError('session not found', 'Session not found'));
      return;
    }

    // Key mismatch is deliberately conflated with "not found" so a key holder
    // cannot probe for other keys' session IDs. Same code, same status.
    if (session.apiKeyId !== apiKey.id) {
      log.warn({ sessionId, expected: session.apiKeyId, got: apiKey.id }, 'session key mismatch');
      writeJsonRpcError(res, new SessionNotFoundError('session key mismatch', 'Session not found'));
      return;
    }

    session.lastActivityMs = Date.now();

    if (method === 'DELETE') {
      await session.transport.handleRequest(req, res);
      await removeSession(sessionId);
      return;
    }

    if (method === 'GET') {
      await session.transport.handleRequest(req, res);
      return;
    }

    // POST with existing session — body was read + parsed above.
    await session.transport.handleRequest(req, res, postPayload);
    return;
  }

  // --- New session (must be POST) ---
  if (method !== 'POST') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Session ID required for non-POST requests' },
        id: null,
      }),
    );
    return;
  }

  // Session caps (AUDIT M-1). Global cap first (backstop), then per-key.
  if (sessions.size >= config.mcpMaxSessionsTotal) {
    log.warn({ size: sessions.size }, 'session creation refused: global cap');
    res.setHeader('Retry-After', '60');
    writeJsonRpcError(
      res,
      new TransientError('global session cap reached', 'Server at capacity, try again shortly.'),
    );
    return;
  }
  let perKeyCount = 0;
  for (const s of sessions.values()) if (s.apiKeyId === apiKey.id) perKeyCount++;
  if (perKeyCount >= config.mcpMaxSessionsPerKey) {
    log.warn(
      { api_key_prefix: apiKey.prefix, perKeyCount },
      'session creation refused: per-key cap',
    );
    // 60s mirrors the global-cap Retry-After below; SECURITY Rule 7
    // requires Retry-After on every 429 (session cap is effectively a
    // coarser rate limit).
    res.setHeader('Retry-After', '60');
    writeJsonRpcError(
      res,
      new RateLimitError('per-key session cap reached', 'Too many sessions for this key.'),
    );
    return;
  }

  let newSessionId: string | undefined;
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => {
      newSessionId = randomUUID();
      return newSessionId;
    },
    enableDnsRebindingProtection: false,
  });

  const mcpServer = new McpServer(
    { name: 'echo', version: PKG_VERSION },
    { capabilities: { tools: {} } },
  );

  registerSessionTools(mcpServer, apiKey, {
    pool,
    redis,
    log,
    registry,
    repo,
    shutdownSignal,
  });

  // postPayload was parsed above (this branch requires method === 'POST'
  // which readBody + parseJsonRpcBody already covered).
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, postPayload);

  if (newSessionId) {
    sessions.set(newSessionId, {
      transport,
      mcpServer,
      apiKeyId: apiKey.id,
      lastActivityMs: Date.now(),
    });
    metrics.activeSessions.inc();
    log.info({ sessionId: newSessionId, api_key_prefix: apiKey.prefix }, 'session created');
  } else {
    // Initialize failed or non-initialize request — clean up.
    await mcpServer.close();
  }
}

function registerSessionTools(
  mcpServer: McpServer,
  apiKey: AuthenticatedKey,
  deps: {
    pool: Pool;
    redis: Redis;
    log: Logger;
    registry: ToolRegistry;
    repo: ApiKeyRepository;
    shutdownSignal: AbortSignal;
  },
): void {
  const { pool, redis, log, registry, repo, shutdownSignal } = deps;

  for (const tool of registry.list()) {
    mcpServer.registerTool(
      tool.name,
      {
        ...(tool.title !== undefined ? { title: tool.title } : {}),
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.requiresConfirmation ? { annotations: { destructiveHint: true } } : {}),
      },
      async (args: Record<string, unknown>): Promise<SdkCallToolResult> => {
        const requestBytes = JSON.stringify(args).length;
        const startMs = Date.now();

        // Per-tool rate limiting now lives at the HTTP layer (AUDIT L-3)
        // so `X-RateLimit-*` and `Retry-After` are attached to the 429.
        // This handler runs only on requests that passed that gate.

        const requestId = randomUUID();
        const timer = metrics.requestDuration.startTimer({ tool: tool.name });

        const ctx = buildToolContext({
          apiKey: {
            id: apiKey.id,
            prefix: apiKey.prefix,
            name: apiKey.name,
            rateLimitPerMinute: apiKey.rateLimitPerMinute,
          },
          toolName: tool.name,
          requestId,
          signal: AbortSignal.any([
            AbortSignal.timeout(config.mcpToolCallTimeoutMs),
            shutdownSignal,
          ]),
          pool,
          redis,
          rootLogger: log,
        });

        ctx.logger.info(registry.redact(tool.name, args), 'tool invoked');

        try {
          const result = (await tool.handler(args, ctx)) as SdkCallToolResult;
          timer();
          const responseBytes = JSON.stringify(result).length;
          const durationMs = Date.now() - startMs;
          metrics.requestsTotal.inc({ tool: tool.name, status: 'success' });
          metrics.requestBytesIn.observe({ tool: tool.name }, requestBytes);
          metrics.requestBytesOut.observe({ tool: tool.name }, responseBytes);
          auditToolCall({
            keyId: apiKey.id,
            keyPrefix: apiKey.prefix,
            tool: tool.name,
            outcome: result.isError ? 'error:tool_is_error' : 'success',
            durationMs,
            bytesIn: requestBytes,
            bytesOut: responseBytes,
          });

          // Fire-and-forget usage persistence to Postgres.
          queueMicrotask(() => {
            repo
              .recordUsage({
                keyId: apiKey.id,
                toolName: tool.name,
                bytesIn: requestBytes,
                bytesOut: responseBytes,
                computeMs: durationMs,
              })
              .catch((err) => {
                log.error({ err, key_id: apiKey.id, tool: tool.name }, 'recordUsage failed');
              });
          });

          return result;
        } catch (err) {
          timer();
          const abortedByShutdown = shutdownSignal.aborted;
          ctx.logger.error({ err, aborted_by_shutdown: abortedByShutdown }, 'tool handler error');
          if (!(err instanceof RateLimitError)) {
            metrics.requestsTotal.inc({
              tool: tool.name,
              status: abortedByShutdown ? 'aborted_shutdown' : 'error',
            });
          }
          auditToolCall({
            keyId: apiKey.id,
            keyPrefix: apiKey.prefix,
            tool: tool.name,
            outcome: abortedByShutdown
              ? 'error:aborted_shutdown'
              : `error:${categorizeToolError(err)}`,
            durationMs: Date.now() - startMs,
            bytesIn: requestBytes,
            bytesOut: 0,
          });
          if (isAppError(err)) throw err;
          throw new TransientError('tool execution failed', 'An error occurred.');
        }
      },
    );
  }
}

export function parseJsonRpcBody(res: ServerResponse, body: Buffer): unknown | null {
  try {
    return JSON.parse(body.toString('utf-8'));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32700, message: 'Parse error' },
        id: null,
      }),
    );
    return null;
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;

    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        // Resume the stream to drain remaining data so the socket stays writable.
        req.resume();
        reject(new Error('Payload too large'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}
