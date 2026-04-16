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
import { buildToolContext } from './core/context.ts';
import { validateHeaders } from './core/headers.ts';
import { metrics, register } from './core/metrics.ts';
import { createRateLimiter, type RateLimiter, type RateLimitResult } from './core/rate-limiter.ts';
import type { ApiKeyRepository } from './db/repos/api-keys.ts';
import { isAppError, RateLimitError, TransientError } from './lib/errors.ts';
import { registerShutdown } from './lib/shutdown.ts';
import type { ToolRegistry } from './shared/tools/loader.ts';

const PKG_VERSION: string = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const MAX_BODY_BYTES = 1_048_576; // 1 MB
const SESSION_IDLE_MS = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL_MS = 60_000; // check every minute
const TOOL_CALL_TIMEOUT_MS = 30_000; // per tool-call abort timeout

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

  /** Idempotent session removal — safe to call multiple times for the same id. */
  const removeSession = async (id: string) => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    metrics.activeSessions.dec();
    try {
      await session.mcpServer.close();
    } catch {
      /* already closed */
    }
  };

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivityMs > SESSION_IDLE_MS) {
        log.info({ sessionId: id }, 'evicting idle session');
        void removeSession(id);
      }
    }
  }, CLEANUP_INTERVAL_MS);
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

  const close = async () => {
    clearInterval(cleanupInterval);
    const promises: Promise<void>[] = [];
    for (const [id] of sessions) {
      promises.push(removeSession(id));
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
  removeSession: (id: string) => Promise<void>;
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

  const allOk = Object.values(checks).every((c) => c.status === 'ok');
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

// Map auth error reasons to bounded metric labels.
function authReasonLabel(error: { jsonRpcCode: number }): string {
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
  const { pool, redis, repo, registry, log, rateLimiter, sessions, removeSession } = deps;
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
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }

  // Step 2: Authenticate.
  const authHeader = req.headers.authorization;
  const authResult = await authenticate(authHeader, repo);

  if (!authResult.ok) {
    const err = authResult.error;
    metrics.authFailuresTotal.inc({ reason: authReasonLabel(err) });
    log.warn({ reason: err.message, code: err.jsonRpcCode }, 'auth failed');
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
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
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

  if (sessionId) {
    // --- Existing session ---
    const session = sessions.get(sessionId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found' },
          id: null,
        }),
      );
      return;
    }

    if (session.apiKeyId !== apiKey.id) {
      log.warn({ sessionId, expected: session.apiKeyId, got: apiKey.id }, 'session key mismatch');
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden' }));
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

    // POST with existing session.
    let body: Buffer;
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }

    await session.transport.handleRequest(req, res, JSON.parse(body.toString('utf-8')));
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

  let body: Buffer;
  try {
    body = await readBody(req, MAX_BODY_BYTES);
  } catch {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Payload too large' }));
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
    rateLimiter,
    registry,
    repo,
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, JSON.parse(body.toString('utf-8')));

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
    rateLimiter: RateLimiter;
    registry: ToolRegistry;
    repo: ApiKeyRepository;
  },
): void {
  const { pool, redis, log, rateLimiter, registry, repo } = deps;

  for (const tool of registry.list()) {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>): Promise<SdkCallToolResult> => {
        // Per-tool rate limiting: enforced at the tool layer, not HTTP layer.
        if (tool.rateLimit) {
          const toolRlResult = await rateLimiter.check({
            scope: `rl:tool:${apiKey.id}:${tool.name}`,
            limit: tool.rateLimit.perMinute,
            windowMs: 60_000,
          });
          if (!toolRlResult.allowed) {
            metrics.rateLimitHitsTotal.inc({ scope: 'per_tool' });
            metrics.requestsTotal.inc({ tool: tool.name, status: 'rate_limited' });
            throw new RateLimitError(
              `per-tool rate limit exceeded for ${tool.name}`,
              `Rate limit exceeded for ${tool.name}. Retry in ${toolRlResult.retryAfterSec}s.`,
            );
          }
        }

        const requestId = randomUUID();
        const requestBytes = JSON.stringify(args).length;
        const startMs = Date.now();
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
          signal: AbortSignal.timeout(TOOL_CALL_TIMEOUT_MS),
          pool,
          redis,
          rootLogger: log,
        });

        try {
          const result = (await tool.handler(args, ctx)) as SdkCallToolResult;
          timer();
          const responseBytes = JSON.stringify(result).length;
          metrics.requestsTotal.inc({ tool: tool.name, status: 'success' });
          metrics.requestBytesIn.observe({ tool: tool.name }, requestBytes);
          metrics.requestBytesOut.observe({ tool: tool.name }, responseBytes);

          // Fire-and-forget usage persistence to Postgres.
          queueMicrotask(() => {
            repo
              .recordUsage({
                keyId: apiKey.id,
                toolName: tool.name,
                bytesIn: requestBytes,
                bytesOut: responseBytes,
                computeMs: Date.now() - startMs,
              })
              .catch((err) => {
                log.error({ err, key_id: apiKey.id, tool: tool.name }, 'recordUsage failed');
              });
          });

          return result;
        } catch (err) {
          timer();
          ctx.logger.error({ err }, 'tool handler error');
          if (!(err instanceof RateLimitError)) {
            metrics.requestsTotal.inc({ tool: tool.name, status: 'error' });
          }
          if (isAppError(err)) throw err;
          throw new TransientError('tool execution failed', 'An error occurred.');
        }
      },
    );
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
