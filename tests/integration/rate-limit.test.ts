import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { startTestServer, type TestServer } from './_helpers/server.ts';

function fetch(
  baseUrl: string,
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
    const url = new URL(path, baseUrl);
    const req = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
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

describe('rate limiting, health, and metrics (integration)', { timeout: 120_000 }, () => {
  let server: TestServer;

  before(async () => {
    server = await startTestServer();
    // Set the test key's rate limit to a low value for testing.
    await server.pool.query('UPDATE api_keys SET rate_limit_per_minute = 5');
  });

  after(async () => {
    await server.close();
  });

  it('allows N requests then returns 429 for N+1', async () => {
    const N = 5;
    const host = new URL(server.url).host;
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

    const results: number[] = [];
    for (let i = 0; i < N + 2; i++) {
      const res = await fetch(server.url, '/mcp', {
        method: 'POST',
        headers: {
          host,
          authorization: `Bearer ${server.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: initBody,
      });
      results.push(res.status);

      // Check rate limit headers on every response.
      assert.ok(res.headers['x-ratelimit-limit'], `request ${i + 1}: expected X-RateLimit-Limit`);
      assert.ok(
        res.headers['x-ratelimit-remaining'] !== undefined,
        `request ${i + 1}: expected X-RateLimit-Remaining`,
      );
      assert.ok(res.headers['x-ratelimit-reset'], `request ${i + 1}: expected X-RateLimit-Reset`);

      if (res.status === 429) {
        assert.ok(res.headers['retry-after'], 'expected Retry-After on 429');
        const body = JSON.parse(res.body);
        assert.equal(body.error.code, -32029, 'expected JSON-RPC rate limit error code');
      }
    }

    const okCount = results.filter((s) => s === 200).length;
    const rateLimited = results.filter((s) => s === 429).length;

    assert.equal(okCount, N, `expected exactly ${N} successful requests`);
    assert.ok(rateLimited >= 1, 'expected at least 1 rate-limited response');
  });

  it('serves Prometheus metrics at /metrics', async () => {
    const metricsRes = await fetch(server.url, '/metrics');
    assert.equal(metricsRes.status, 200);
    assert.ok(metricsRes.body.includes('mcp_requests_total'), 'expected mcp_requests_total');
    assert.ok(
      metricsRes.body.includes('mcp_auth_failures_total'),
      'expected mcp_auth_failures_total',
    );
    assert.ok(
      metricsRes.body.includes('mcp_rate_limit_hits_total'),
      'expected mcp_rate_limit_hits_total',
    );
    assert.ok(metricsRes.body.includes('# HELP'), 'expected HELP lines');
    assert.ok(metricsRes.body.includes('# TYPE'), 'expected TYPE lines');
  });

  it('returns full /health with DB and Redis checks', async () => {
    const healthRes = await fetch(server.url, '/health');
    assert.equal(healthRes.status, 200);
    const body = JSON.parse(healthRes.body);
    assert.equal(body.status, 'ok');
    assert.equal(body.checks.db.status, 'ok');
    assert.ok(typeof body.checks.db.latency_ms === 'number');
    assert.equal(body.checks.redis.status, 'ok');
    assert.ok(typeof body.checks.redis.latency_ms === 'number');
    assert.ok(typeof body.uptime_s === 'number');
  });
});
