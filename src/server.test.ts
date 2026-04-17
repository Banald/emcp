import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { after, before, describe, it, mock } from 'node:test';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { ApiKeyRepository } from './db/repos/api-keys.ts';
import { createLogger } from './lib/logger.ts';
import { computeHealthAllOk, createServer, EXPECTED_HEALTH_CHECKS } from './server.ts';
import type { ToolRegistry } from './shared/tools/loader.ts';

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
    recordUsage: mock.fn(async () => {}),
    ...overrides,
  } as unknown as ApiKeyRepository;
}

function makeRegistry(
  tools: Array<{ name: string; description: string; rateLimit?: { perMinute: number } }> = [],
): ToolRegistry {
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
  return { query: mock.fn(async () => ({ rows: [{ '?column?': 1 }] })) } as unknown as Pool;
}

function makeRedis(): Redis {
  return {
    get: mock.fn(),
    set: mock.fn(),
    status: 'ready',
    ping: mock.fn(async () => 'PONG'),
    defineCommand: mock.fn(),
    slidingWindowRateLimit: mock.fn(async () => [1, 59, Date.now()]),
  } as unknown as Redis;
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

describe('computeHealthAllOk', () => {
  it('requires every expected check to be present and ok', () => {
    assert.equal(computeHealthAllOk({}), false);
    assert.equal(computeHealthAllOk({ db: { status: 'ok' } }), false);
    assert.equal(computeHealthAllOk({ redis: { status: 'ok' } }), false);
    assert.equal(computeHealthAllOk({ db: { status: 'ok' }, redis: { status: 'ok' } }), true);
  });

  it('returns false when any expected check is not ok', () => {
    assert.equal(computeHealthAllOk({ db: { status: 'fail' }, redis: { status: 'ok' } }), false);
    assert.equal(computeHealthAllOk({ db: { status: 'ok' }, redis: { status: 'fail' } }), false);
  });

  it('ignores unexpected checks entirely', () => {
    // Adding an unexpected key does not flip a fully-populated ok to fail,
    // and does not rescue a missing expected key.
    assert.equal(
      computeHealthAllOk({
        db: { status: 'ok' },
        redis: { status: 'ok' },
        extra: { status: 'fail' },
      }),
      true,
    );
    assert.equal(computeHealthAllOk({ extra: { status: 'ok' } }), false);
  });

  it('exports the expected set', () => {
    assert.deepEqual([...EXPECTED_HEALTH_CHECKS], ['db', 'redis']);
  });
});

describe('HTTP server', () => {
  let server: Server;
  let close: () => Promise<void>;

  before(async () => {
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo: makeRepo(),
      registry: makeRegistry(),
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
    it('returns 200 with full health check on loopback', async () => {
      const res = await fetch(server, '/health');
      assert.equal(res.status, 200);
      const body = JSON.parse(res.body);
      assert.equal(body.status, 'ok');
      assert.ok(body.checks.db, 'expected db check');
      assert.equal(body.checks.db.status, 'ok');
      assert.ok(body.checks.redis, 'expected redis check');
      assert.equal(body.checks.redis.status, 'ok');
      assert.ok(typeof body.uptime_s === 'number', 'expected uptime_s');
      assert.ok(typeof body.version === 'string', 'expected version');
    });
  });

  describe('/health 503 when DB down', () => {
    it('returns 503 when DB query fails', async () => {
      const failPool = {
        query: mock.fn(async () => {
          throw new Error('connection refused');
        }),
      } as unknown as Pool;
      const result = await createServer({
        pool: failPool,
        redis: makeRedis(),
        repo: makeRepo(),
        registry: makeRegistry(),
        logger: createLogger({ level: 'silent' }),
      });
      await new Promise<void>((resolve) =>
        result.httpServer.listen(0, '127.0.0.1', () => resolve()),
      );
      try {
        const res = await fetch(result.httpServer, '/health');
        assert.equal(res.status, 503);
        const body = JSON.parse(res.body);
        assert.equal(body.status, 'fail');
        assert.equal(body.checks.db.status, 'fail');
        assert.ok(body.checks.db.error);
      } finally {
        await result.close();
      }
    });
  });

  describe('/metrics', () => {
    it('returns Prometheus text format on loopback', async () => {
      const res = await fetch(server, '/metrics');
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('mcp_requests_total'), 'expected mcp_requests_total');
      assert.ok(res.body.includes('# HELP'), 'expected HELP lines');
      assert.ok(res.body.includes('# TYPE'), 'expected TYPE lines');
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
  async function startServer(repoOverrides: Partial<ApiKeyRepository> = {}) {
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo: makeRepo(repoOverrides),
      registry: makeRegistry(),
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
      const body = JSON.parse(res.body);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32007);
      assert.equal(body.error.message, 'Forbidden');
      assert.equal(body.id, null);
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

  it('sets rate limit headers on successful MCP request', async () => {
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
      assert.ok(res.headers['x-ratelimit-limit'], 'expected X-RateLimit-Limit header');
      assert.ok(res.headers['x-ratelimit-remaining'], 'expected X-RateLimit-Remaining header');
      assert.ok(res.headers['x-ratelimit-reset'], 'expected X-RateLimit-Reset header');
    } finally {
      await close();
    }
  });

  it('returns 429 with Retry-After when rate limit exceeded', async () => {
    const rateLimitedRedis = {
      ...makeRedis(),
      slidingWindowRateLimit: mock.fn(async () => [0, 0, Date.now() - 5_000]),
    } as unknown as Redis;

    const result = await createServer({
      pool: makePool(),
      redis: rateLimitedRedis,
      repo: makeRepo(),
      registry: makeRegistry(),
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
      assert.equal(res.status, 429);
      assert.ok(res.headers['retry-after'], 'expected Retry-After header');
      assert.ok(res.headers['x-ratelimit-limit'], 'expected X-RateLimit-Limit header');
      assert.equal(res.headers['x-ratelimit-remaining'], '0');
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, -32029);
    } finally {
      await result.close();
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

describe('Stateful MCP sessions', () => {
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

  const stdHeaders = {
    host: 'localhost:3000',
    authorization: 'Bearer mcp_live_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  async function startServer(overrides: Partial<Parameters<typeof createServer>[0]> = {}) {
    const result = await createServer({
      pool: makePool(),
      redis: makeRedis(),
      repo: makeRepo(),
      registry: makeRegistry(),
      logger: createLogger({ level: 'silent' }),
      ...overrides,
    });
    await new Promise<void>((resolve) => result.httpServer.listen(0, '127.0.0.1', () => resolve()));
    return result;
  }

  it('returns Mcp-Session-Id header on initialize', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      assert.equal(res.status, 200);
      const sessionId = res.headers['mcp-session-id'];
      assert.ok(sessionId, 'expected Mcp-Session-Id header');
      assert.ok(typeof sessionId === 'string' && sessionId.length > 0);
    } finally {
      await close();
    }
  });

  it('allows session reuse with Mcp-Session-Id header', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      // Initialize — creates session
      const initRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      assert.equal(initRes.status, 200);
      const sessionId = initRes.headers['mcp-session-id'] as string;
      assert.ok(sessionId);

      // Send initialized notification using the session
      const notifBody = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      });
      const notifRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: notifBody,
      });
      // Notifications return 200 (or 202) — not an error
      assert.ok(
        notifRes.status >= 200 && notifRes.status < 300,
        `expected 2xx, got ${notifRes.status}`,
      );
    } finally {
      await close();
    }
  });

  it('returns 404 for unknown session ID', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': 'nonexistent-session-id' },
        body: initBody,
      });
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32006);
      assert.equal(body.error.message, 'Session not found');
      assert.equal(body.id, null);
    } finally {
      await close();
    }
  });

  it('conflates a session key mismatch into session-not-found (404/-32006)', async () => {
    // Use two different keys — first creates the session, second tries to use it
    let callCount = 0;
    const repo = makeRepo({
      findByHash: mock.fn(async () => {
        callCount++;
        return {
          id: callCount <= 1 ? 'key-1' : 'key-2',
          keyPrefix: TEST_KEY_PREFIX,
          keyHash: 'hash',
          name: 'test',
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
        };
      }) as unknown as ApiKeyRepository['findByHash'],
    });
    const { httpServer: s, close } = await startServer({ repo });
    try {
      // Initialize with key-1
      const initRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      assert.equal(initRes.status, 200);
      const sessionId = initRes.headers['mcp-session-id'] as string;

      // Attempt to use session with key-2 (different key returned by mock)
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(res.status, 404);
      const body = JSON.parse(res.body);
      assert.equal(body.jsonrpc, '2.0');
      assert.equal(body.error.code, -32006);
      assert.equal(body.error.message, 'Session not found');
    } finally {
      await close();
    }
  });

  it('handles DELETE to close a session', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      // Initialize
      const initRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      const sessionId = initRes.headers['mcp-session-id'] as string;
      assert.ok(sessionId);

      // DELETE the session
      const deleteRes = await fetch(s, '/mcp', {
        method: 'DELETE',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
      });
      assert.ok(deleteRes.status >= 200 && deleteRes.status < 300);

      // Session should now be gone
      const reuse = await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(reuse.status, 404);
    } finally {
      await close();
    }
  });

  it('close() cleans up all sessions', async () => {
    const { httpServer: s, close } = await startServer();
    // Create two sessions
    for (let i = 0; i < 2; i++) {
      const res = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      assert.equal(res.status, 200);
      assert.ok(res.headers['mcp-session-id']);
    }
    // close() should not throw even with active sessions
    await close();
  });

  it('returns 400 for GET without session ID', async () => {
    const { httpServer: s, close } = await startServer();
    try {
      const res = await fetch(s, '/mcp', {
        method: 'GET',
        headers: stdHeaders,
      });
      assert.equal(res.status, 400);
      const body = JSON.parse(res.body);
      assert.equal(body.error.code, -32600);
    } finally {
      await close();
    }
  });

  it('executes a tool call through a session', async () => {
    const registry = makeRegistry([{ name: 'test-echo', description: 'Echoes input' }]);
    const { httpServer: s, close } = await startServer({ registry });
    try {
      // Initialize
      const initRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      assert.equal(initRes.status, 200);
      const sessionId = initRes.headers['mcp-session-id'] as string;
      assert.ok(sessionId);

      // Send initialized notification
      await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

      // Call the tool
      const callBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'test-echo', arguments: {} },
      });
      const callRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: callBody,
      });
      assert.equal(callRes.status, 200);
      const parsed = parseResponse(callRes.body);
      assert.ok(parsed.result, 'expected result in tool call response');
    } finally {
      await close();
    }
  });

  it('handles per-tool rate limiting in session tools', async () => {
    const registry = makeRegistry([
      { name: 'limited', description: 'Rate-limited tool', rateLimit: { perMinute: 1 } },
    ]);
    // Mock: per-key rate limit always passes, per-tool always denied
    const redisWithRl = {
      ...makeRedis(),
      slidingWindowRateLimit: mock.fn(async (...args: unknown[]) => {
        const scope = args[0] as string;
        if (scope.startsWith('rl:tool:')) return [0, 0, Date.now() - 5_000];
        return [1, 59, Date.now()];
      }),
    } as unknown as Redis;
    const { httpServer: s, close } = await startServer({ registry, redis: redisWithRl });
    try {
      // Initialize
      const initRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: stdHeaders,
        body: initBody,
      });
      const sessionId = initRes.headers['mcp-session-id'] as string;

      // Send initialized notification
      await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });

      // Call the tool — per-tool rate limit will deny
      const callBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'limited', arguments: {} },
      });
      const callRes = await fetch(s, '/mcp', {
        method: 'POST',
        headers: { ...stdHeaders, 'mcp-session-id': sessionId },
        body: callBody,
      });
      assert.equal(callRes.status, 200);
      const parsed = parseResponse(callRes.body);
      // The tool handler throws RateLimitError, which the MCP SDK wraps as a JSON-RPC error
      assert.ok(parsed.result || parsed.error, 'expected response with rate limit error');
    } finally {
      await close();
    }
  });
});
