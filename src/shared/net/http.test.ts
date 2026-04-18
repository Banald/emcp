import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it, mock } from 'node:test';
import { ValidationError } from '../../lib/errors.ts';
import {
  type AssertPublicHost,
  createPinnedFetcher,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type DnsResolver,
  type Fetcher,
  fetchSafe,
  type NodeRequester,
  type PinnedFetcher,
} from './http.ts';
import { USER_AGENT } from './user-agent.ts';

function makeResponse(
  body: string | Uint8Array,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body as BodyInit, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'text/plain; charset=utf-8' },
  });
}

function redirectResponse(location: string | null, status = 301): Response {
  const headers = new Headers();
  if (location !== null) headers.set('Location', location);
  return new Response(null, { status, headers });
}

const allowHost: AssertPublicHost = async () => {};

describe('fetchSafe', () => {
  it('returns body, status, contentType on a 200 response', async () => {
    const fetcher = mock.fn<Fetcher>(async () =>
      makeResponse('hello', { headers: { 'content-type': 'text/plain; charset=utf-8' } }),
    );
    const result = await fetchSafe('https://example.com/thing', {
      fetcher,
      assertPublicHost: allowHost,
    });
    assert.equal(result.status, 200);
    assert.equal(result.finalUrl, 'https://example.com/thing');
    assert.equal(result.contentType, 'text/plain; charset=utf-8');
    assert.equal(result.body.toString('utf-8'), 'hello');
    assert.equal(result.wireTruncated, false);
    assert.equal(fetcher.mock.callCount(), 1);
    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    assert.equal((init.headers as Record<string, string>)['User-Agent'], USER_AGENT);
    assert.equal(init.redirect, 'manual');
  });

  it('merges caller headers on top of the default User-Agent', async () => {
    const fetcher = mock.fn<Fetcher>(async () => makeResponse('x'));
    await fetchSafe('https://example.com/', {
      fetcher,
      assertPublicHost: allowHost,
      headers: { Accept: 'application/json' },
    });
    const init = fetcher.mock.calls[0].arguments[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    assert.equal(headers['User-Agent'], USER_AGENT);
    assert.equal(headers.Accept, 'application/json');
  });

  it('follows a 301 redirect and runs SSRF on every hop', async () => {
    let call = 0;
    const fetcher: Fetcher = async () => {
      call++;
      return call === 1 ? redirectResponse('https://final.example.com/dest') : makeResponse('ok');
    };
    const guard = mock.fn<AssertPublicHost>(async () => {});
    const result = await fetchSafe('https://example.com/start', {
      fetcher,
      assertPublicHost: guard,
    });
    assert.equal(result.finalUrl, 'https://final.example.com/dest');
    assert.equal(guard.mock.callCount(), 2);
    assert.deepEqual(
      guard.mock.calls.map((c) => c.arguments[0]),
      ['example.com', 'final.example.com'],
    );
  });

  it('throws after exceeding the maxRedirects cap', async () => {
    const fetcher = mock.fn<Fetcher>(async () => redirectResponse('https://example.com/loop'));
    await assert.rejects(
      () =>
        fetchSafe('https://example.com/start', {
          fetcher,
          assertPublicHost: allowHost,
          maxRedirects: 2,
        }),
      /too many redirects/,
    );
  });

  it('throws when a redirect has no Location header', async () => {
    const fetcher = mock.fn<Fetcher>(async () => redirectResponse(null));
    await assert.rejects(
      () => fetchSafe('https://example.com/', { fetcher, assertPublicHost: allowHost }),
      /no Location header/,
    );
  });

  it('throws when a redirect Location is malformed', async () => {
    // `http://[invalid` is a malformed IPv6 host — new URL() rejects it even with a base.
    const fetcher = mock.fn<Fetcher>(async () => redirectResponse('http://[invalid'));
    await assert.rejects(
      () => fetchSafe('https://example.com/', { fetcher, assertPublicHost: allowHost }),
      /invalid Location/,
    );
  });

  it('throws on non-http(s) after a redirect hop', async () => {
    const fetcher = mock.fn<Fetcher>(async () => redirectResponse('ftp://example.com/x'));
    await assert.rejects(
      () => fetchSafe('https://example.com/', { fetcher, assertPublicHost: allowHost }),
      /unsupported protocol/,
    );
  });

  it('surfaces SSRF failures from the guard', async () => {
    const fetcher = mock.fn<Fetcher>(async () => makeResponse('nope'));
    const guard: AssertPublicHost = async (hostname) => {
      throw new Error(`SSRF refused: ${hostname}`);
    };
    await assert.rejects(
      () => fetchSafe('https://private.local/', { fetcher, assertPublicHost: guard }),
      /SSRF refused/,
    );
    assert.equal(fetcher.mock.callCount(), 0);
  });

  it('maps TimeoutError into a friendly timeout message', async () => {
    const fetcher: Fetcher = async () => {
      throw new DOMException('timed out', 'TimeoutError');
    };
    await assert.rejects(
      () =>
        fetchSafe('https://example.com/', {
          fetcher,
          assertPublicHost: allowHost,
          timeoutMs: 1234,
        }),
      /timed out after 1234ms/,
    );
  });

  it('maps AbortError into "request aborted"', async () => {
    const fetcher: Fetcher = async () => {
      throw new DOMException('aborted', 'AbortError');
    };
    await assert.rejects(
      () => fetchSafe('https://example.com/', { fetcher, assertPublicHost: allowHost }),
      /request aborted/,
    );
  });

  it('wraps generic (non-DOMException) network errors', async () => {
    const fetcher: Fetcher = async () => {
      throw new TypeError('ECONNRESET');
    };
    await assert.rejects(
      () => fetchSafe('https://example.com/', { fetcher, assertPublicHost: allowHost }),
      /network error: ECONNRESET/,
    );
  });

  it('caps body reads at maxBytes and flags wireTruncated', async () => {
    const long = Buffer.alloc(1024, 'a');
    const fetcher = mock.fn<Fetcher>(async () => makeResponse(long));
    const result = await fetchSafe('https://example.com/', {
      fetcher,
      assertPublicHost: allowHost,
      maxBytes: 100,
    });
    assert.equal(result.body.length, 100);
    assert.equal(result.wireTruncated, true);
  });

  it('rejects invalid URLs without calling fetch', async () => {
    const fetcher = mock.fn<Fetcher>(async () => makeResponse('x'));
    await assert.rejects(
      () => fetchSafe('not a url', { fetcher, assertPublicHost: allowHost }),
      /invalid URL/,
    );
    assert.equal(fetcher.mock.callCount(), 0);
  });

  it('rejects non-http(s) schemes on the initial URL', async () => {
    const fetcher = mock.fn<Fetcher>(async () => makeResponse('x'));
    await assert.rejects(
      () => fetchSafe('file:///etc/passwd', { fetcher, assertPublicHost: allowHost }),
      /unsupported protocol/,
    );
    assert.equal(fetcher.mock.callCount(), 0);
  });

  it('observes the caller signal before issuing a redirect follow-up request', async () => {
    // The first hop returns a redirect; by the time we loop, the caller signal has aborted.
    // fetchSafe must re-check before the second fetch call so shutdown propagates.
    const controller = new AbortController();
    let callCount = 0;
    const fetcher: Fetcher = async (url) => {
      callCount++;
      if (callCount === 1) {
        controller.abort();
        return redirectResponse(`${url}-next`);
      }
      return makeResponse('too late');
    };
    await assert.rejects(
      () =>
        fetchSafe('https://example.com/', {
          fetcher,
          assertPublicHost: allowHost,
          signal: controller.signal,
        }),
      /request aborted/,
    );
    assert.equal(callCount, 1, 'must not issue the redirected request after the signal aborts');
  });

  it('exposes sensible default constants', () => {
    assert.equal(DEFAULT_MAX_BYTES, 2 * 1024 * 1024);
    assert.equal(DEFAULT_MAX_REDIRECTS, 5);
    assert.equal(DEFAULT_TIMEOUT_MS, 20_000);
  });

  it('uses the pinnedFetcher seam when no fetcher is provided', async () => {
    // Covers the production code path where DNS pinning is required and
    // the caller has not passed a mock fetcher.
    const pinnedFetcher = mock.fn<PinnedFetcher>(async () => makeResponse('via-pinned'));
    const result = await fetchSafe('https://example.com/', { pinnedFetcher });
    assert.equal(result.status, 200);
    assert.equal(result.body.toString('utf-8'), 'via-pinned');
    assert.equal(pinnedFetcher.mock.callCount(), 1);
    const [calledUrl, calledInit] = pinnedFetcher.mock.calls[0].arguments;
    assert.equal(calledUrl.hostname, 'example.com');
    assert.equal(calledInit.method, 'GET');
    assert.equal(calledInit.headers['User-Agent'], USER_AGENT);
  });

  it('surfaces a pinned-fetcher ValidationError verbatim', async () => {
    const pinnedFetcher: PinnedFetcher = async (url) => {
      throw new ValidationError(
        `hostname ${url.hostname} resolves to a non-public address`,
        'URLs resolving to internal addresses are not allowed.',
      );
    };
    await assert.rejects(
      () => fetchSafe('https://private.invalid/', { pinnedFetcher }),
      (err: Error) => err instanceof ValidationError && /non-public address/.test(err.message),
    );
  });

  it('maps a pinned-fetcher TimeoutError', async () => {
    const pinnedFetcher: PinnedFetcher = async () => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    };
    await assert.rejects(
      () => fetchSafe('https://example.com/', { pinnedFetcher, timeoutMs: 2000 }),
      /timed out after 2000ms/,
    );
  });
});

describe('createPinnedFetcher', () => {
  const publicRecord = { address: '93.184.216.34', family: 4 } as const;
  const privateRecord = { address: '127.0.0.1', family: 4 } as const;

  it('looks up once, validates every address, pins the connect to the first', async () => {
    const resolver = mock.fn<DnsResolver>(async () => [publicRecord]);
    const request = mock.fn<NodeRequester>(async () => makeResponse('ok'));
    const pinned = createPinnedFetcher({ resolver, request });
    const ctrl = new AbortController();
    const res = await pinned(new URL('https://example.com/x'), {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT },
      signal: ctrl.signal,
    });
    assert.equal(res.status, 200);
    assert.equal(resolver.mock.callCount(), 1);
    assert.equal(request.mock.callCount(), 1);
    const [_url, _init, pinnedLookup] = request.mock.calls[0].arguments;
    await new Promise<void>((resolve) => {
      pinnedLookup('example.com', { family: 0 }, (err, address, family) => {
        assert.equal(err, null);
        assert.equal(address, publicRecord.address);
        assert.equal(family, publicRecord.family);
        resolve();
      });
    });
  });

  it('rejects before any connect when a resolver yields a private address', async () => {
    const resolver = mock.fn<DnsResolver>(async () => [privateRecord]);
    const request = mock.fn<NodeRequester>(async () => {
      throw new Error('should not reach here');
    });
    const pinned = createPinnedFetcher({ resolver, request });
    await assert.rejects(
      () =>
        pinned(new URL('https://rebind.example/'), {
          method: 'GET',
          headers: {},
          signal: new AbortController().signal,
        }),
      (err: Error) => err instanceof ValidationError && /non-public address/.test(err.message),
    );
    assert.equal(request.mock.callCount(), 0);
  });

  it('rejects if ANY resolved address is private (mixed list)', async () => {
    const resolver = mock.fn<DnsResolver>(async () => [publicRecord, privateRecord]);
    const request = mock.fn<NodeRequester>(async () => {
      throw new Error('should not reach here');
    });
    const pinned = createPinnedFetcher({ resolver, request });
    await assert.rejects(
      () =>
        pinned(new URL('https://half-bad.example/'), {
          method: 'GET',
          headers: {},
          signal: new AbortController().signal,
        }),
      (err: Error) => err instanceof ValidationError,
    );
    assert.equal(request.mock.callCount(), 0);
  });

  it('rejects when the resolver returns no addresses', async () => {
    const resolver = mock.fn<DnsResolver>(async () => []);
    const request = mock.fn<NodeRequester>(async () => makeResponse('ok'));
    const pinned = createPinnedFetcher({ resolver, request });
    await assert.rejects(
      () =>
        pinned(new URL('https://nxdomain.invalid/'), {
          method: 'GET',
          headers: {},
          signal: new AbortController().signal,
        }),
      (err: Error) => err instanceof ValidationError && /no addresses/.test(err.message),
    );
    assert.equal(request.mock.callCount(), 0);
  });

  it('retries with the next IP on ECONNREFUSED (happy-eyeballs substitute)', async () => {
    const ipA = { address: '203.0.113.1', family: 4 } as const;
    const ipB = { address: '203.0.113.2', family: 4 } as const;
    const resolver = mock.fn<DnsResolver>(async () => [ipA, ipB]);
    const request = mock.fn<NodeRequester>(async (_url, _init, pinnedLookup) => {
      // Inspect the pinned lookup to determine which IP is being tried.
      let pinnedIp = '';
      await new Promise<void>((resolve) => {
        pinnedLookup('x', { family: 0 }, (_err, addr) => {
          pinnedIp = typeof addr === 'string' ? addr : '';
          resolve();
        });
      });
      if (pinnedIp === ipA.address) {
        const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
        throw err;
      }
      return makeResponse('second-ok');
    });
    const pinned = createPinnedFetcher({ resolver, request });
    const res = await pinned(new URL('https://two-ips.example/'), {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'second-ok');
    assert.equal(request.mock.callCount(), 2);
  });

  it('does not retry on non-connect errors', async () => {
    const resolver = mock.fn<DnsResolver>(async () => [publicRecord, publicRecord]);
    const request = mock.fn<NodeRequester>(async () => {
      throw new Error('TLS handshake failed');
    });
    const pinned = createPinnedFetcher({ resolver, request });
    await assert.rejects(
      () =>
        pinned(new URL('https://tls-broken.example/'), {
          method: 'GET',
          headers: {},
          signal: new AbortController().signal,
        }),
      /TLS handshake failed/,
    );
    assert.equal(request.mock.callCount(), 1);
  });

  it('uses the default private-address check unless overridden', async () => {
    // Sanity: passing an explicit isPrivate override that allows everything
    // bypasses the built-in rejection of 127.0.0.1.
    const resolver = mock.fn<DnsResolver>(async () => [privateRecord]);
    const request = mock.fn<NodeRequester>(async () => makeResponse('allowed'));
    const pinned = createPinnedFetcher({ resolver, request, isPrivate: () => false });
    const res = await pinned(new URL('https://override.example/'), {
      method: 'GET',
      headers: {},
      signal: new AbortController().signal,
    });
    assert.equal(res.status, 200);
    assert.equal(request.mock.callCount(), 1);
  });
});

describe('fetchSafe proxy: "auto"', () => {
  // Build a fake pool whose size is non-zero; fetchSafe only cares about
  // `size` on the ProxyPool interface to decide whether the proxy path
  // is active. Routing itself goes through the `proxiedFetch` seam.
  const fakePool = (size: number) =>
    ({
      size,
      strategy: 'round-robin',
      next: () => null,
      report: () => {},
      healthSnapshot: () => [],
      healthyCount: () => size,
      close: () => Promise.resolve(),
    }) as unknown as import('./proxy/types.ts').ProxyPool;

  it('stays on the pinned path when pool is null', async () => {
    const pinnedFetcher = mock.fn(async () =>
      makeResponse('pinned', { headers: { 'content-type': 'text/plain' } }),
    );
    const proxiedFetch = mock.fn(async () => makeResponse('proxied'));
    await fetchSafe('https://example.com/', {
      proxyPool: null,
      pinnedFetcher,
      proxiedFetch,
    });
    assert.equal(pinnedFetcher.mock.callCount(), 1);
    assert.equal(proxiedFetch.mock.callCount(), 0);
  });

  it('stays on the pinned path when pool size is 0', async () => {
    const pinnedFetcher = mock.fn(async () => makeResponse('pinned'));
    const proxiedFetch = mock.fn(async () => makeResponse('proxied'));
    await fetchSafe('https://example.com/', {
      proxyPool: fakePool(0),
      pinnedFetcher,
      proxiedFetch,
    });
    assert.equal(pinnedFetcher.mock.callCount(), 1);
    assert.equal(proxiedFetch.mock.callCount(), 0);
  });

  it('uses the proxied path when pool size > 0, calling the SSRF guard first', async () => {
    const pinnedFetcher = mock.fn(async () => makeResponse('pinned'));
    const proxiedFetch = mock.fn(async () =>
      makeResponse('proxied', { headers: { 'content-type': 'text/plain' } }),
    );
    const guard = mock.fn<AssertPublicHost>(async () => {});
    const result = await fetchSafe('https://example.com/path', {
      proxyPool: fakePool(2),
      proxiedFetch,
      pinnedFetcher,
      assertPublicHost: guard,
    });
    assert.equal(proxiedFetch.mock.callCount(), 1);
    assert.equal(pinnedFetcher.mock.callCount(), 0);
    // Guard ran on the target hostname before the proxied connect.
    assert.equal(guard.mock.callCount(), 1);
    assert.equal(guard.mock.calls[0].arguments[0], 'example.com');
    assert.equal(result.body.toString('utf-8'), 'proxied');
  });

  it('re-runs the SSRF guard on each redirect hop in proxied mode', async () => {
    const guard = mock.fn<AssertPublicHost>(async () => {});
    let call = 0;
    const proxiedFetch = mock.fn(async () => {
      call++;
      return call === 1 ? redirectResponse('https://final.example.com/dest') : makeResponse('ok');
    });
    await fetchSafe('https://start.example.com/', {
      proxyPool: fakePool(1),
      proxiedFetch,
      assertPublicHost: guard,
    });
    assert.deepEqual(
      guard.mock.calls.map((c) => c.arguments[0]),
      ['start.example.com', 'final.example.com'],
    );
  });

  it('forces the pinned path when proxy: "off" even with a non-empty pool', async () => {
    const pinnedFetcher = mock.fn(async () => makeResponse('pinned'));
    const proxiedFetch = mock.fn(async () => makeResponse('proxied'));
    await fetchSafe('https://example.com/', {
      proxy: 'off',
      proxyPool: fakePool(3),
      pinnedFetcher,
      proxiedFetch,
    });
    assert.equal(pinnedFetcher.mock.callCount(), 1);
    assert.equal(proxiedFetch.mock.callCount(), 0);
  });

  it('passes through an injected `fetcher` even when a pool is available (test-seam precedence)', async () => {
    const injected = mock.fn<Fetcher>(async () => makeResponse('injected'));
    const proxiedFetch = mock.fn(async () => makeResponse('proxied'));
    await fetchSafe('https://example.com/', {
      fetcher: injected,
      assertPublicHost: allowHost,
      proxyPool: fakePool(5),
      proxiedFetch,
    });
    assert.equal(injected.mock.callCount(), 1);
    assert.equal(proxiedFetch.mock.callCount(), 0);
  });

  it('lets TransientError from proxiedFetch bubble unchanged', async () => {
    const proxiedFetch = mock.fn(async () => {
      throw new (await import('../../lib/errors.ts')).TransientError(
        'pool exhausted',
        'External service is temporarily unavailable. Please try again.',
      );
    });
    await assert.rejects(
      () =>
        fetchSafe('https://example.com/', {
          proxyPool: fakePool(2),
          proxiedFetch,
        }),
      (err: unknown) =>
        err instanceof Error && err.name === 'TransientError' && /pool exhausted/.test(err.message),
    );
  });

  it('lets ValidationError from the SSRF guard bubble unchanged in proxied mode', async () => {
    const guard = mock.fn<AssertPublicHost>(async () => {
      throw new ValidationError('blocked', 'URLs resolving to internal addresses are not allowed.');
    });
    const proxiedFetch = mock.fn(async () => makeResponse('ok'));
    await assert.rejects(
      () =>
        fetchSafe('https://private.local/', {
          proxyPool: fakePool(1),
          proxiedFetch,
          assertPublicHost: guard,
        }),
      ValidationError,
    );
    assert.equal(proxiedFetch.mock.callCount(), 0);
  });

  it('maps generic proxied-fetch errors through the standard error wrapper', async () => {
    const proxiedFetch = mock.fn(async () => {
      throw new Error('boom');
    });
    await assert.rejects(
      () =>
        fetchSafe('https://example.com/', {
          proxyPool: fakePool(1),
          proxiedFetch,
        }),
      /network error: boom/,
    );
  });
});
