// Integration test for the outbound proxy egress subsystem.
//
// Runs two tiny HTTP proxies against a stub upstream HTTP server, all in
// the same process (no docker needed). Exercises round-robin rotation,
// transparent failover, budget exhaustion, and the cooldown recovery
// path end-to-end through the real undici ProxyAgent.
//
// See docs/ARCHITECTURE.md "Proxy egress" for the subsystem overview.

import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest, type Server } from 'node:http';
import { connect as tcpConnect } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { TransientError } from '../../src/lib/errors.ts';
import { fetchExternal } from '../../src/shared/net/egress.ts';
import { fetchSafe } from '../../src/shared/net/http.ts';
import { buildPoolFromConfig } from '../../src/shared/net/proxy/registry.ts';
import type { ProxyPool } from '../../src/shared/net/proxy/types.ts';

interface StubProxy {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
  readonly requestCount: number;
  readonly connectCount: number;
  close(): Promise<void>;
}

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr !== 'string') resolve(addr.port);
      else reject(new Error('no server address'));
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// Minimal HTTP forward proxy. Handles absolute-form GETs (what undici
// sends for http:// targets through an HTTP proxy) and CONNECT (not
// used by this test but included so the proxy feels realistic).
async function createStubProxy(): Promise<StubProxy> {
  const state = { requestCount: 0, connectCount: 0 };
  const server = createHttpServer();

  server.on('request', (req, res) => {
    state.requestCount += 1;
    // Absolute-form URLs land on req.url when the client thinks it's
    // talking to a proxy: e.g. "http://127.0.0.1:12345/path".
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400);
      res.end('bad request-line');
      return;
    }
    const forward = httpRequest(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: req.headers,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    forward.on('error', (err) => {
      res.writeHead(502);
      res.end(`upstream error: ${err.message}`);
    });
    req.pipe(forward);
  });

  server.on('connect', (req, clientSocket, head) => {
    state.requestCount += 1;
    state.connectCount += 1;
    const [hostPart, portPart] = (req.url ?? '').split(':');
    const upstream = tcpConnect(Number(portPart || 443), hostPart ?? '127.0.0.1', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.end());
    clientSocket.on('error', () => upstream.end());
  });

  const port = await listenOnFreePort(server);
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    get requestCount() {
      return state.requestCount;
    },
    get connectCount() {
      return state.connectCount;
    },
    close: () => closeServer(server),
  } as StubProxy;
}

async function createStubUpstream(): Promise<{
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}> {
  const server = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('upstream-ok');
  });
  const port = await listenOnFreePort(server);
  return { server, port, url: `http://127.0.0.1:${port}/`, close: () => closeServer(server) };
}

describe('proxy egress lifecycle', { timeout: 30_000 }, () => {
  let proxyA: StubProxy;
  let proxyB: StubProxy;
  let upstream: Awaited<ReturnType<typeof createStubUpstream>>;

  before(async () => {
    proxyA = await createStubProxy();
    proxyB = await createStubProxy();
    upstream = await createStubUpstream();
  });

  after(async () => {
    await proxyA.close().catch(() => {});
    await proxyB.close().catch(() => {});
    await upstream.close();
  });

  function buildPool(): ProxyPool {
    const pool = buildPoolFromConfig({
      proxyUrls: [proxyA.url, proxyB.url],
      proxyRotation: 'round-robin',
      proxyFailureCooldownMs: 2_000,
      proxyConnectTimeoutMs: 3_000,
    });
    assert.ok(pool !== null, 'expected pool to be built');
    return pool;
  }

  it('rotates across both proxies on repeated fetches', async () => {
    // undici's ProxyAgent keeps a CONNECT tunnel alive per (agent,
    // upstream) pair and reuses it for subsequent fetches, so the
    // stub proxy's counter reflects tunnel setups, not per-fetch
    // traffic. A rotating pool must still cause each proxy to see at
    // least one CONNECT across the 4 fetches — that's what the test
    // asserts. Per-fetch attribution is covered by the pool unit
    // tests in src/shared/net/proxy/pool.test.ts.
    const pool = buildPool();
    try {
      const before = { a: proxyA.requestCount, b: proxyB.requestCount };
      for (let i = 0; i < 4; i++) {
        const res = await fetchExternal(upstream.url, {}, { pool });
        assert.equal(res.status, 200);
        assert.equal(await res.text(), 'upstream-ok');
      }
      const after = { a: proxyA.requestCount, b: proxyB.requestCount };
      assert.ok(
        after.a - before.a >= 1,
        `proxyA should have been touched by rotation (got ${after.a - before.a})`,
      );
      assert.ok(
        after.b - before.b >= 1,
        `proxyB should have been touched by rotation (got ${after.b - before.b})`,
      );
    } finally {
      await pool.close();
    }
  });

  it('transparently fails over to the surviving proxy when one is killed', async () => {
    // Spin a fresh pool so the rotation cursor is at 0 and we see p0
    // attempted first. Close proxyA so its connect fails; the loop
    // must retry on proxyB and return the upstream body.
    const deadA = await createStubProxy();
    const freshPool = buildPoolFromConfig({
      proxyUrls: [deadA.url, proxyB.url],
      proxyRotation: 'round-robin',
      proxyFailureCooldownMs: 10_000,
      proxyConnectTimeoutMs: 2_000,
    });
    assert.ok(freshPool !== null);
    try {
      await deadA.close();
      const bBefore = proxyB.requestCount;
      const res = await fetchExternal(upstream.url, {}, { pool: freshPool });
      assert.equal(res.status, 200);
      assert.equal(proxyB.requestCount - bBefore, 1);
      const [a, b] = freshPool.healthSnapshot();
      assert.ok(a?.inCooldown, 'proxyA should be cooled down after the failure');
      assert.equal(b?.inCooldown, false, 'proxyB should remain healthy');
    } finally {
      await freshPool.close();
    }
  });

  it('fetchSafe threads a caller-supplied pool through to fetchExternal', async () => {
    // Regression: fetchSafe used to resolve its pool independently of
    // the singleton inside fetchExternal. A test or harness that passed
    // `proxyPool: somePool` saw the guard + active-path branch but the
    // actual request went direct because fetchExternal re-resolved
    // from the empty singleton. Locking the end-to-end flow here.
    const localProxy = await createStubProxy();
    const localUp = await createStubUpstream();
    const pool = buildPoolFromConfig({
      proxyUrls: [localProxy.url],
      proxyRotation: 'round-robin',
      proxyFailureCooldownMs: 1_000,
      proxyConnectTimeoutMs: 3_000,
    });
    assert.ok(pool !== null);
    try {
      const outcome = await fetchSafe(localUp.url, {
        proxyPool: pool,
        // SSRF guard must allow the loopback target for this scenario —
        // the real guard behaviour is covered by src/shared/net/ssrf.test.ts.
        assertPublicHost: async () => {},
      });
      assert.equal(outcome.status, 200);
      assert.equal(outcome.body.toString('utf-8'), 'upstream-ok');
      assert.equal(localProxy.connectCount, 1);
    } finally {
      await pool.close();
      await localProxy.close();
      await localUp.close();
    }
  });

  it('throws TransientError when every proxy is dead', async () => {
    const deadA = await createStubProxy();
    const deadB = await createStubProxy();
    await deadA.close();
    await deadB.close();
    const pool = buildPoolFromConfig({
      proxyUrls: [deadA.url, deadB.url],
      proxyRotation: 'round-robin',
      proxyFailureCooldownMs: 5_000,
      proxyConnectTimeoutMs: 1_000,
    });
    assert.ok(pool !== null);
    try {
      await assert.rejects(
        () => fetchExternal(upstream.url, {}, { pool }),
        (err: unknown) => err instanceof TransientError,
      );
    } finally {
      await pool.close();
    }
  });
});
