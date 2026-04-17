import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it, mock } from 'node:test';
import {
  type AssertPublicHost,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_TIMEOUT_MS,
  type Fetcher,
  fetchSafe,
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
});
