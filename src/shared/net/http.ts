import { Buffer } from 'node:buffer';
import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { TransientError, ValidationError } from '../../lib/errors.ts';
import { fetchExternal } from './egress.ts';
import { getProxyPool } from './proxy/registry.ts';
import type { ProxyPool } from './proxy/types.ts';
import { assertPublicHostname, isPrivateAddress } from './ssrf.ts';
import { USER_AGENT } from './user-agent.ts';

/**
 * Shared HTTP fetcher used by tools and workers. Implements the redirect
 * loop, DNS pinning (defeats the classic rebinding TOCTOU between the SSRF
 * check and the connect), capped body read, AbortError/TimeoutError
 * mapping, and the canonical User-Agent. Callers format their own output
 * around the returned metadata + body buffer.
 */

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type AssertPublicHost = (hostname: string) => Promise<void>;

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}
export type DnsResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface PinnedFetcherInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}
export type PinnedFetcher = (url: URL, init: PinnedFetcherInit) => Promise<Response>;

export interface FetchSafeOptions {
  /** Caller-scoped signal (tool context, worker context). Combined with the internal timeout. */
  readonly signal?: AbortSignal;
  /** Per-call timeout in ms. Default 20_000. */
  readonly timeoutMs?: number;
  /** Wire-byte cap on the response body. Default 2 MiB. */
  readonly maxBytes?: number;
  /** Maximum redirects to follow. Default 5. */
  readonly maxRedirects?: number;
  /** Extra request headers. User-Agent is always set by `fetchSafe`; other headers merge on top. */
  readonly headers?: Record<string, string>;
  /**
   * Proxy routing policy. `'auto'` (default): when the egress proxy pool
   * is non-empty, the connect step is delegated to `fetchExternal` and
   * the DNS-pinning path is bypassed (can't pre-pin across CONNECT).
   * SSRF guards still run on every hop's target hostname. `'off'` forces
   * the direct path even when a pool is configured — reserved for
   * diagnostics / probes against the proxy itself.
   *
   * The DNS-rebinding TOCTOU window lost in proxy mode is an inherent
   * property of CONNECT tunneling; see docs/SECURITY.md Rule 13.
   */
  readonly proxy?: 'auto' | 'off';
  /**
   * Test seam: override the network call with a mock. When set, the SSRF
   * guard is invoked *separately* before every hop via `assertPublicHost`.
   * When unset, the pinned flow below runs instead — one DNS lookup whose
   * result is both validated and reused for the connect, closing the
   * rebinding TOCTOU window.
   */
  readonly fetcher?: Fetcher;
  /** Test seam: override the SSRF guard. Only consulted when `fetcher` is set. */
  readonly assertPublicHost?: AssertPublicHost;
  /** Test seam: override the pinned flow. Only consulted when `fetcher` is NOT set. */
  readonly pinnedFetcher?: PinnedFetcher;
  /** Test seam: inject a proxy pool (overrides the module singleton). */
  readonly proxyPool?: ProxyPool | null;
  /**
   * Test seam: override the function that routes through the proxy pool.
   * Defaults to `fetchExternal`. Called with absolute URL + RequestInit.
   */
  readonly proxiedFetch?: (url: string, init: RequestInit) => Promise<Response>;
}

export interface FetchSafeResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Buffer;
  readonly wireTruncated: boolean;
}

export type NodeRequester = (
  url: URL,
  init: PinnedFetcherInit,
  lookup: LookupFunction,
) => Promise<Response>;

export interface CreatePinnedFetcherDeps {
  readonly resolver?: DnsResolver;
  readonly request?: NodeRequester;
  readonly isPrivate?: (addr: string) => boolean;
}

/**
 * Build a pinned fetcher. The default wiring uses `dns.lookup` + node:https
 * / node:http with a custom `lookup` so the OS resolver is consulted once
 * per hop. Tests inject in-memory resolver/request stubs via the deps
 * argument to cover both the happy path and the rebinding rejection.
 */
export function createPinnedFetcher(deps: CreatePinnedFetcherDeps = {}): PinnedFetcher {
  const resolver = deps.resolver ?? defaultDnsResolver;
  const request = deps.request ?? defaultNodeRequester;
  const isPrivate = deps.isPrivate ?? isPrivateAddress;
  return async (url, init) => {
    const records = await resolver(url.hostname);
    if (records.length === 0) {
      throw new ValidationError(
        `hostname ${url.hostname} resolved to no addresses`,
        'URLs resolving to internal addresses are not allowed.',
      );
    }
    // Validate every record: a single private answer is enough to reject
    // (mirrors the existing `assertPublicHostname` contract).
    for (const r of records) {
      if (isPrivate(r.address)) {
        throw new ValidationError(
          `hostname ${url.hostname} resolves to a non-public address`,
          'URLs resolving to internal addresses are not allowed.',
        );
      }
    }
    // Iterate in resolver order. The first connect that succeeds wins;
    // connect-level failures (ECONNREFUSED / EHOSTUNREACH / ENETUNREACH)
    // fall through to the next record so a dead IPv6 path doesn't bury a
    // working IPv4 one. Body-level failures bubble without retry.
    let lastErr: unknown;
    for (const r of records) {
      const pinned: LookupFunction = (_host, _opts, cb) => {
        cb(null, r.address, r.family);
      };
      try {
        return await request(url, init, pinned);
      } catch (err) {
        lastErr = err;
        if (!isConnectError(err)) throw err;
      }
    }
    throw lastErr ?? new Error(`unable to connect to any resolved address for ${url.hostname}`);
  };
}

const defaultDnsResolver: DnsResolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true });
  return records.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

const defaultNodeRequester: NodeRequester = (url, init, pinned) =>
  new Promise<Response>((resolve, reject) => {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = requestFn(url, {
      method: init.method,
      headers: init.headers,
      lookup: pinned,
      signal: init.signal,
    });
    req.on('response', (res) => {
      // IncomingMessage → web ReadableStream so the shared readCappedBody()
      // can consume it identically to a Response body produced by fetch().
      const stream = Readable.toWeb(res) as ReadableStream<Uint8Array>;
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) headers.append(k, item);
        } else {
          headers.set(k, v);
        }
      }
      resolve(
        new Response(stream, {
          status: res.statusCode ?? 0,
          headers,
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });

function isConnectError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rec = err as { code?: string; cause?: { code?: string } };
  const code = rec.code ?? rec.cause?.code;
  return code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH';
}

// Mutable default — resolved once at module load. Exposed as a test seam
// below so unit tests can intercept the pinned flow without mocking the
// global fetch (which is no longer on this code path).
let defaultPinnedFetcher: PinnedFetcher = createPinnedFetcher();

/**
 * Test-only hook: replace the module-level pinned fetcher. Passing `null`
 * restores the real (DNS-backed) implementation. Matches the __setX pattern
 * used for the pg pool and Redis singletons.
 */
export function __setDefaultPinnedFetcherForTesting(f: PinnedFetcher | null): void {
  defaultPinnedFetcher = f ?? createPinnedFetcher();
}

/**
 * Fetch a URL safely: follows redirects, pins DNS per hop, caps the
 * response body, maps abort/timeout into ordinary Errors, and throws on
 * every non-success path.
 */
export async function fetchSafe(
  url: string,
  options: FetchSafeOptions = {},
): Promise<FetchSafeResult> {
  const fetcher = options.fetcher;
  const guard = options.assertPublicHost ?? assertPublicHostname;
  const pinnedFetcher = options.pinnedFetcher ?? defaultPinnedFetcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  // `proxy: 'auto'` (default) engages the pool when it is non-empty.
  // `proxy: 'off'` forces direct/pinned even when a pool is configured.
  // When a caller has injected an explicit `fetcher` (test seam), proxy
  // mode is skipped — test fetchers already control egress directly.
  const proxyMode = options.proxy ?? 'auto';
  const pool =
    fetcher === undefined && proxyMode === 'auto'
      ? options.proxyPool !== undefined
        ? options.proxyPool
        : getProxyPool()
      : null;
  const proxyActive = pool !== null && pool.size > 0;
  // Thread the resolved pool into fetchExternal so callers supplying a
  // non-singleton pool (tests, integration harnesses) get a consistent
  // view. In production fetchExternal would resolve the same singleton
  // anyway — passing it explicitly is a no-op there.
  const proxiedFetch =
    options.proxiedFetch ?? ((u: string, init: RequestInit) => fetchExternal(u, init, { pool }));

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error('invalid URL');
  }
  let redirects = 0;

  while (true) {
    if (combinedSignal.aborted) throw new Error('request aborted');

    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${current.protocol}" (only http and https allowed)`);
    }

    let response: Response;
    const headers = {
      'User-Agent': USER_AGENT,
      ...(options.headers ?? {}),
    };

    if (fetcher) {
      // Legacy/test path: SSRF guard runs first and any error it throws
      // bubbles verbatim (existing tests assert on guard-specific
      // messages). Network-level errors go through the mapping layer
      // below.
      await guard(current.hostname);
      try {
        response = await fetcher(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: combinedSignal,
          headers,
        });
      } catch (err) {
        throw mapFetchError(err, timeoutMs);
      }
    } else if (proxyActive) {
      // Proxied path: SSRF guard runs on the target hostname so the
      // client-side DNS check still rejects private addresses. The
      // actual connect goes via fetchExternal -> undici ProxyAgent,
      // which can't pre-pin DNS across the CONNECT tunnel — that
      // TOCTOU trade-off is documented in docs/SECURITY.md Rule 13.
      await guard(current.hostname);
      try {
        response = await proxiedFetch(current.toString(), {
          method: 'GET',
          redirect: 'manual',
          signal: combinedSignal,
          headers,
        });
      } catch (err) {
        // fetchExternal itself throws TransientError when the whole
        // pool is exhausted; that already has a sensible public
        // message. Let it + ValidationError bubble unchanged.
        if (err instanceof ValidationError) throw err;
        if (err instanceof TransientError) throw err;
        throw mapFetchError(err, timeoutMs);
      }
    } else {
      // Production path: one lookup, validate every record, pinned
      // connect. SSRF rejections surface as ValidationError and must
      // bubble unchanged so callers (and their tests) can pattern-match
      // on the public message.
      try {
        response = await pinnedFetcher(current, {
          method: 'GET',
          headers,
          signal: combinedSignal,
        });
      } catch (err) {
        if (err instanceof ValidationError) throw err;
        throw mapFetchError(err, timeoutMs);
      }
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error(`redirect ${response.status} with no Location header`);
      }
      redirects++;
      if (redirects > maxRedirects) {
        throw new Error(`too many redirects (>${maxRedirects})`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`redirect ${response.status} has invalid Location "${location}"`);
      }
      current = next;
      continue;
    }

    const { buffer, wireTruncated } = await readCappedBody(response, maxBytes);
    return {
      finalUrl: current.toString(),
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: buffer,
      wireTruncated,
    };
  }
}

function mapFetchError(err: unknown, timeoutMs: number): Error {
  if (err instanceof Error && err.name === 'TimeoutError') {
    return new Error(`timed out after ${timeoutMs}ms`);
  }
  if (err instanceof Error && err.name === 'AbortError') {
    return new Error('request aborted');
  }
  return new Error(`network error: ${err instanceof Error ? err.message : String(err)}`);
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; wireTruncated: boolean }> {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), wireTruncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        const overflow = total - maxBytes;
        const keep = value.length - overflow;
        if (keep > 0) chunks.push(value.subarray(0, keep));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  return { buffer: Buffer.concat(chunks), wireTruncated: truncated };
}
