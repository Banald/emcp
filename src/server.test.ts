import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { after, before, describe, it, mock } from 'node:test';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { ApiKeyRepository } from './db/repos/api-keys.ts';
import { createLogger } from './lib/logger.ts';
import { createServer } from './server.ts';
import type { ToolRegistry } from './tools/loader.ts';

// Stable test key hash and authentication setup
const TEST_KEY_PREFIX = 'mcp_live_k7Hj';
const TEST_KEY_ID = 'test-key-uuid';

function makeRepo(overrides: Partial<ApiKeyRepository> = {}): ApiKeyRepository {
  return {
    findByHash: mock.fn(async () => ({
      id: TEST_KEY_ID,
      keyPrefix: TEST_KEY_PREFIX,
      keyHash: 'fake-hash',
      name: 'test-key',
      status: 'active' as const,
      rateLimitPerMinute: 60,
      allowNoOrigin: true,
      createdAt: new Date(),
      lastUsedAt: null,
      blacklistedAt: null,
      deletedAt: null,
      requestCount: 0n,
      bytesIn: 0n,
      bytesOut: 0n,
      totalComputeMs: 0n,
    })),
    touchLastUsed: mock.fn(async () => {}),
    ...overrides,
  } as unknown as ApiKeyRepository;
}

function makeRegistry(tools: Array<{ name: string; description: string }> = []): ToolRegistry {
  const map = new Map(
    tools.map((t) => [
      t.name,
      {
        ...t,
        inputSchema: {},
        handler: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      },
    ]),
  );
  return {
    list: () => [...map.values()],
    get: (name: string) => map.get(name),
  };
}

function makePool(): Pool {
  return { query: mock.fn(async () => ({ rows: [] })) } as unknown as Pool;
}

function makeRedis(): Redis {
  return { get: mock.fn(), set: mock.fn(), status: 'ready' } as unknown as Redis;
}

function fetch(
  server: Server,
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) return reject(new Error('no address'));
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: addr.port,
        path,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
      },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: Buffer.concat(chunks).toString('utf-8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

describe('HTTP server', () => {
  let server: Server;
  let close: () => Promise<void>;

  before(async () => {
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo: makeRepo(),
      registry: makeRegistry(),
      queues: {},
      logger: createLogger({ level: 'silent' }),
    });
    server = result.httpServer;
    close = result.close;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  });

  after(async () => {
    await close();
  });

  describe('/health', () => {
    it('returns 200 with status ok on loopback', async () => {
      const res = await fetch(server, '/health');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
    });
  });

  describe('/metrics', () => {
    it('returns 404 (not implemented yet)', async () => {
      const res = await fetch(server, '/metrics');
      assert.equal(res.status, 404);
    });
  });

  describe('unknown routes', () => {
    it('returns 404 for unknown paths', async () => {
      const res = await fetch(server, '/unknown');
      assert.equal(res.status, 404);
    });
  });
});

describe('MCP endpoint auth and headers', () => {
  // Each test in this block gets its own server with custom repo/registry

  async function startServer(repoOverrides: Partial<ApiKeyRepository> = {}) {
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo: makeRepo(repoOverrides),
      registry: makeRegistry(),
      queues: {},
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => result.httpServer.listen(0, '127.0.0.1', () => resolve()));
    return result;
  }

  it('returns 401 when Authorization header is missing', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 401);
      const body = JSON.parse(res.body);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32001);
    } finally {
      await close();
    }
  });

  it('returns 401 for invalid bearer token', async () => {
    const { httpServer: s, close } = await startServer({
      findByHash: mock.fn(async () => null) as unknown as ApiKeyRepository['findByHash'],
    });
    try {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 401);
    } finally {
      await close();
    }
  });

  it('returns 403 for blacklisted key', async () => {
    const { httpServer: s, close } = await startServer({
      findByHash: mock.fn(async () => ({
        id: TEST_KEY_ID,
        keyPrefix: TEST_KEY_PREFIX,
        keyHash: 'hash',
        name: 'test',
        status: 'blacklisted' as const,
        rateLimitPerMinute: 60,
        allowNoOrigin: true,
        createdAt: new Date(),
        lastUsedAt: null,
        blacklistedAt: new Date(),
        deletedAt: null,
        requestCount: 0n,
        bytesIn: 0n,
        bytesOut: 0n,
        totalComputeMs: 0n,
      })) as unknown as ApiKeyRepository['findByHash'],
    });
    try {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 403);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, -32004);
    } finally {
      await close();
    }
  });

  it('returns 403 for bad Host header', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: {
          host: 'evil.example.com',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 403);
    } finally {
      await close();
    }
  });

  it('returns 413 for oversized body', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const bigBody = 'x'.repeat(2_000_000);
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
        },
        body: bigBody,
      });
      assert.equal(res.status, 413);
    } finally {
      await close();
    }
  });

  it('returns MCP initialize response for valid auth with empty tool registry', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      });
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: initBody,
      });
      assert.equal(res.status, 200);
      // Stateless mode returns SSE or JSON. Parse the MCP response.
      const parsed = parseResponse(res.body);
      const result = parsed.result as Record<string, unknown>;
      assert.ok(result, 'expected a result in the initialize response');
      assert.ok(result.capabilities, 'expected capabilities in the initialize response');
      assert.equal(result.protocolVersion, '2025-03-26');
    } finally {
      await close();
    }
  });
});

// Helper to parse MCP responses which may be SSE or JSON
function parseResponse(body: string): Record<string, unknown> {
  // Try plain JSON first.
  try {
    return JSON.parse(body);
  } catch {
    // SSE format: each event is "event: message\ndata: {...}\n\n"
    const lines = body.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          return JSON.parse(line.slice(6));
        } catch {}
      }
    }
    throw new Error(`Could not parse response: ${body.slice(0, 200)}`);
  }
}

describe('Per-key origin requirement', () => {
  it('returns 403 when key requires origin but none is sent', async () => {
    const repo = makeRepo({
      findByHash: mock.fn(async () => ({
        id: TEST_KEY_ID,
        keyPrefix: TEST_KEY_PREFIX,
        keyHash: 'hash',
        name: 'strict-key',
        status: 'active' as const,
        rateLimitPerMinute: 60,
        allowNoOrigin: false, // requires Origin
        createdAt: new Date(),
        lastUsedAt: null,
        blacklistedAt: null,
        deletedAt: null,
        requestCount: 0n,
        bytesIn: 0n,
        bytesOut: 0n,
        totalComputeMs: 0n,
      })) as unknown as ApiKeyRepository['findByHash'],
    });
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo,
      registry: makeRegistry(),
      queues: {},
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => result.httpServer.listen(0, '127.0.0.1', () => resolve()));
    try {
      const res = await fetch(result.httpServer, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 403);
    } finally {
      await result.close();
    }
  });
});

describe('Deleted key rejection', () => {
  it('returns 403 for a deleted key', async () => {
    const repo = makeRepo({
      findByHash: mock.fn(async () => ({
        id: TEST_KEY_ID,
        keyPrefix: TEST_KEY_PREFIX,
        keyHash: 'hash',
        name: 'dead-key',
        status: 'deleted' as const,
        rateLimitPerMinute: 60,
        allowNoOrigin: true,
        createdAt: new Date(),
        lastUsedAt: null,
        blacklistedAt: null,
        deletedAt: new Date(),
        requestCount: 0n,
        bytesIn: 0n,
        bytesOut: 0n,
        totalComputeMs: 0n,
      })) as unknown as ApiKeyRepository['findByHash'],
    });
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo,
      registry: makeRegistry(),
      queues: {},
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => result.httpServer.listen(0, '127.0.0.1', () => resolve()));
    try {
      const res = await fetch(result.httpServer, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(res.status, 403);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, -32005);
    } finally {
      await result.close();
    }
  });
});

describe('MCP with registered tool', () => {
  it('lists a registered tool in the initialize response', async () => {
    const registry = makeRegistry([{ name: 'test-echo', description: 'Echoes input' }]);
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo: makeRepo(),
      registry,
      queues: {},
      logger: createLogger({ level: 'silent' }),
    });
    await new Promise<void>((resolve) => result.httpServer.listen(0, '127.0.0.1', () => resolve()));
    try {
      const initBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0' },
        },
      });
      const res = await fetch(result.httpServer, '/mcp', {
        method: 'POST',
        headers: {
          host: 'localhost:3000',
          authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: initBody,
      });
      assert.equal(res.status, 200);
      const parsed = parseResponse(res.body);
      const caps = (parsed.result as Record<string, unknown>).capabilities as Record<
        string,
        unknown
      >;
      assert.ok(caps.tools, 'server should advertise tools capability');
    } finally {
      await result.close();
    }
  });
});
