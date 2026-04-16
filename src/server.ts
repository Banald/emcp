import { randomUUID } from 'node:crypto';
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
import { authenticate } from './core/auth.ts';
import { buildToolContext } from './core/context.ts';
import { validateHeaders } from './core/headers.ts';
import type { ApiKeyRepository } from './db/repos/api-keys.ts';
import { isAppError, TransientError } from './lib/errors.ts';
import { registerShutdown } from './lib/shutdown.ts';
import type { ToolRegistry } from './tools/loader.ts';
import type { Queue } from './tools/types.ts';

const MAX_BODY_BYTES = 1_048_576; // 1 MB

interface ServerDeps {
  pool: Pool;
  redis: Redis;
  repo: ApiKeyRepository;
  registry: ToolRegistry;
  queues: Readonly<Record<string, Queue>>;
  logger: Logger;
}

export async function createServer(
  deps: ServerDeps,
): Promise<{ httpServer: Server; close: () => Promise<void> }> {
  const { pool, redis, repo, registry, queues, logger: log } = deps;

  const httpServer = createHttpServer(async (req, res) => {
    try {
      await handleRequest(req, res, { pool, redis, repo, registry, queues, log });
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
  queues: Readonly<Record<string, Queue>>;
  log: Logger;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const url = req.url ?? '/';
  const method = req.method ?? 'GET';

  if (url === '/health' && method === 'GET') {
    return handleHealth(req, res);
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

function handleHealth(req: IncomingMessage, res: ServerResponse): void {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}

function handleMetrics(req: IncomingMessage, res: ServerResponse): void {
  if (!isLoopback(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Forbidden' }));
    return;
  }
  // TODO(phase-6): Prometheus metrics endpoint
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not implemented' }));
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  deps: HandlerDeps,
): Promise<void> {
  const { pool, redis, repo, registry, queues, log } = deps;
  const method = req.method ?? 'GET';

  // For DELETE requests, we still validate headers and auth but don't read body.
  // For GET (SSE), we validate headers and auth.
  // For POST, we read and parse the body.

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

  // Step 4: Read body for POST requests.
  let body: Buffer | undefined;
  if (method === 'POST') {
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return;
    }
  }

  // Step 5: Generate request ID and abort controller.
  const requestId = randomUUID();
  const abortController = new AbortController();
  req.on('close', () => abortController.abort());

  // Step 6: Create per-request MCP transport and server.
  // TODO(phase-7): consider stateful sessions for server-initiated notifications
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode for Phase 3
    enableDnsRebindingProtection: false, // We handle this ourselves
  });

  const mcpServer = new McpServer(
    { name: 'echo', version: '0.0.0' },
    { capabilities: { tools: {} } },
  );

  // Step 7: Register tools.
  // TODO(phase-6): record per-request metrics (bytes_in, bytes_out, compute_ms) here
  for (const tool of registry.list()) {
    mcpServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>): Promise<SdkCallToolResult> => {
        const ctx = buildToolContext({
          apiKey: {
            id: apiKey.id,
            prefix: apiKey.prefix,
            name: apiKey.name,
            rateLimitPerMinute: apiKey.rateLimitPerMinute,
          },
          toolName: tool.name,
          requestId,
          signal: abortController.signal,
          pool,
          redis,
          queues,
          rootLogger: log,
        });
        try {
          return (await tool.handler(args, ctx)) as SdkCallToolResult;
        } catch (err) {
          ctx.logger.error({ err }, 'tool handler error');
          if (isAppError(err)) throw err;
          throw new TransientError('tool execution failed', 'An error occurred.');
        }
      },
    );
  }

  // Step 8: Connect and handle.
  await mcpServer.connect(transport);

  const parsedBody = body !== undefined ? JSON.parse(body.toString('utf-8')) : undefined;
  await transport.handleRequest(req, res, parsedBody);

  // Clean up after the request.
  await mcpServer.close();
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
