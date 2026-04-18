import { config } from '../../config.ts';
import { TransientError } from '../../lib/errors.ts';
import { getProxyPool } from './proxy/registry.ts';
import type { ProxyOutcome, ProxyPool } from './proxy/types.ts';

/**
 * `fetchExternal` — the single egress chokepoint for outbound HTTP from
 * tools and workers.
 *
 * Behaviour:
 *   - Pool empty (PROXY_URLS unset) → plain global `fetch()`. Zero
 *     overhead; the feature is invisible to callers.
 *   - Pool non-empty → asks the pool for the next healthy proxy, threads
 *     its `undici.ProxyAgent` through `fetch()` via the `dispatcher`
 *     option, and on connect-level failure retries on the next proxy
 *     until the retry budget (`PROXY_MAX_RETRIES_PER_REQUEST`) is spent.
 *
 * Failure taxonomy:
 *   - Any `Response` return is treated as a successful proxy round-trip;
 *     upstream 4xx/5xx HTTP statuses are the upstream's problem, not the
 *     proxy's, so they never mark the proxy unhealthy.
 *   - Fetch errors whose code/cause matches a known connect/timeout set
 *     are classified as `connect_failure`, the pool is notified, and the
 *     loop moves to the next proxy.
 *   - Fetch errors triggered by the caller's `AbortSignal` bubble
 *     immediately as `aborted`; the pool is notified but no retry is
 *     attempted — the caller asked to stop.
 *   - Anything else bubbles as-is (not proxy-related).
 *
 * After the retry budget is exhausted with only connect-level failures,
 * `TransientError` is thrown — a 503/-32013 response that client retries
 * per the app's error contract (src/lib/errors.ts).
 */

const KNOWN_CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);

export interface FetchExternalOptions {
  /**
   * Force-disable proxy usage for this one call. Reserved for callers
   * that MUST hit the upstream directly (e.g., a health probe against
   * the proxy itself). Tools and workers should NOT set this.
   */
  readonly bypassProxy?: boolean;
  /**
   * Injectable pool for tests. Defaults to the module singleton.
   * Null means "pool disabled" for this call.
   */
  readonly pool?: ProxyPool | null;
  /**
   * Injectable fetch function for tests. Defaults to globalThis.fetch.
   */
  readonly fetcher?: typeof fetch;
}

export async function fetchExternal(
  url: string,
  init: RequestInit = {},
  options: FetchExternalOptions = {},
): Promise<Response> {
  const doFetch = options.fetcher ?? globalThis.fetch;

  if (options.bypassProxy === true) {
    return doFetch(url, init);
  }

  const pool = options.pool === undefined ? getProxyPool() : options.pool;
  if (pool === null || pool.size === 0) {
    return doFetch(url, init);
  }

  const maxAttempts = Math.min(config.proxyMaxRetriesPerRequest, pool.size);
  const attempted = new Set<string>();
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const entry = pool.next();
    if (entry === null) break;
    // If the pool keeps handing us the same entry (single healthy
    // proxy), don't burn the whole retry budget on it — bail early.
    if (attempted.has(entry.id) && attempted.size < pool.size) {
      // try once more; pool may rotate on next call
    }
    attempted.add(entry.id);

    try {
      const response = await doFetch(url, {
        ...init,
        // undici's Dispatcher is valid for fetch's `dispatcher` option on
        // Node 18+. The fetch Response type doesn't formally include it,
        // hence the cast.
        ...({ dispatcher: entry.dispatcher } as Record<string, unknown>),
      });
      pool.report(entry.id, 'success');
      return response;
    } catch (err) {
      const outcome = classifyError(err, init.signal);
      pool.report(entry.id, outcome);
      lastError = err;
      if (outcome === 'aborted') throw err;
      // connect_failure or upstream_failure → try the next proxy.
    }
  }

  throw new TransientError(
    `all ${attempted.size} proxy attempt(s) exhausted for ${safeUrlLabel(url)}: ${errMessage(lastError)}`,
    'External service is temporarily unavailable. Please try again.',
  );
}

export function classifyError(err: unknown, signal: AbortSignal | null | undefined): ProxyOutcome {
  if (signal?.aborted === true) return 'aborted';
  if (isAbortLike(err)) return 'aborted';
  const code = extractCode(err);
  if (code !== null && KNOWN_CONNECT_ERROR_CODES.has(code)) {
    return 'connect_failure';
  }
  // Anything else is unexpected. Treat as connect_failure so the pool
  // rotates (better to briefly cool a potentially-fine proxy than to
  // route the same broken hop in a hot loop). The retry budget caps
  // the blast radius.
  return 'upstream_failure';
}

function isAbortLike(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError';
}

function extractCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const rec = err as { code?: unknown; cause?: { code?: unknown } };
  if (typeof rec.code === 'string') return rec.code;
  if (rec.cause && typeof rec.cause === 'object' && typeof rec.cause.code === 'string') {
    return rec.cause.code;
  }
  return null;
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err ?? '');
}

// Drop credentials and query for log output. The URL scheme + host are
// enough to identify the upstream without risking a secret-in-query
// style leak. Callers that need to log the full URL elsewhere are
// responsible for their own redaction.
function safeUrlLabel(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return '<invalid-url>';
  }
}
