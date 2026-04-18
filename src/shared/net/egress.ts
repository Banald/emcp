import { fetch as undiciFetch } from 'undici';
import { config } from '../../config.ts';
import { metrics as realMetrics } from '../../core/metrics.ts';
import { TransientError } from '../../lib/errors.ts';
import { getProxyPool } from './proxy/registry.ts';
import type { ProxyOutcome, ProxyPool } from './proxy/types.ts';

// Adapt undici's fetch (Response type) to the global fetch signature so
// callers and tests can reason about one concrete return type. undici's
// Response is structurally compatible with the global Response — the
// only difference is a stricter dispatcher contract, which is exactly
// what we need for ProxyAgent to work.
const undiciFetchAsGlobal = undiciFetch as unknown as typeof fetch;

export interface EgressMetrics {
  readonly requestsTotal: { inc(labels: { proxy_id: string; status: string }): void };
  readonly requestDuration: { observe(labels: { proxy_id: string }, value: number): void };
  readonly cooldownsTotal: { inc(labels: { proxy_id: string }): void };
  readonly poolHealthy: { set(value: number): void };
}

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
  /** Injectable metrics for tests. Defaults to the shared prom-client registry. */
  readonly metrics?: EgressMetrics;
  /** Test seam: override Date.now for deterministic duration assertions. */
  readonly now?: () => number;
}

const defaultEgressMetrics: EgressMetrics = {
  requestsTotal: realMetrics.proxyRequestsTotal,
  requestDuration: realMetrics.proxyRequestDuration,
  cooldownsTotal: realMetrics.proxyCooldownsTotal,
  poolHealthy: realMetrics.proxyPoolHealthy,
};

export async function fetchExternal(
  url: string,
  init: RequestInit = {},
  options: FetchExternalOptions = {},
): Promise<Response> {
  // Bypass path uses globalThis.fetch so existing tool tests that stub
  // `mock.method(globalThis, 'fetch', ...)` continue to work unchanged.
  const bypassFetch = options.fetcher ?? globalThis.fetch;

  if (options.bypassProxy === true) {
    return bypassFetch(url, init);
  }

  const pool = options.pool === undefined ? getProxyPool() : options.pool;
  if (pool === null || pool.size === 0) {
    return bypassFetch(url, init);
  }

  // Proxied path uses undici's fetch so the ProxyAgent dispatcher is
  // version-matched with the undici package we installed. Node's built-in
  // fetch uses a bundled (older) undici copy whose internal dispatch API
  // is incompatible with a ProxyAgent from the installed package.
  // Callers that inject `options.fetcher` are trusted to use a matching
  // fetch/dispatcher pair (integration tests + stubs).
  const proxiedFetcher = options.fetcher ?? undiciFetchAsGlobal;

  const metrics = options.metrics ?? defaultEgressMetrics;
  const now = options.now ?? Date.now;
  const maxAttempts = Math.min(config.proxyMaxRetriesPerRequest, pool.size);
  const attempted = new Set<string>();
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const entry = pool.next();
    if (entry === null) break;
    attempted.add(entry.id);
    const startedAt = now();

    // Snapshot the proxy's cooldown state before the report() call so we
    // can tell whether this particular failure *triggered* a cooldown
    // (vs. reporting another failure during an existing one). The
    // cooldown counter fires only on the transition null→scheduled or a
    // forward shift, not on every failure.
    const beforeCooldown =
      pool.healthSnapshot().find((h) => h.id === entry.id)?.cooldownUntil ?? null;

    try {
      const response = await proxiedFetcher(url, {
        ...init,
        // undici's Dispatcher is valid for fetch's `dispatcher` option on
        // Node 18+. The fetch Response type doesn't formally include it,
        // hence the cast.
        ...({ dispatcher: entry.dispatcher } as Record<string, unknown>),
      });
      pool.report(entry.id, 'success');
      recordOutcome(metrics, entry.id, 'success', startedAt, now);
      metrics.poolHealthy.set(pool.healthyCount());
      return response;
    } catch (err) {
      const outcome = classifyError(err, init.signal);
      pool.report(entry.id, outcome);
      recordOutcome(metrics, entry.id, outcome, startedAt, now);
      const afterCooldown =
        pool.healthSnapshot().find((h) => h.id === entry.id)?.cooldownUntil ?? null;
      if (hasNewCooldown(beforeCooldown, afterCooldown, now())) {
        metrics.cooldownsTotal.inc({ proxy_id: entry.id });
      }
      metrics.poolHealthy.set(pool.healthyCount());
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

function recordOutcome(
  metrics: EgressMetrics,
  proxyId: string,
  outcome: ProxyOutcome,
  startedAt: number,
  now: () => number,
): void {
  metrics.requestsTotal.inc({ proxy_id: proxyId, status: outcome });
  const durationSeconds = Math.max(0, (now() - startedAt) / 1000);
  metrics.requestDuration.observe({ proxy_id: proxyId }, durationSeconds);
}

function hasNewCooldown(before: number | null, after: number | null, nowMs: number): boolean {
  if (after === null) return false;
  if (after <= nowMs) return false;
  if (before === null) return true;
  return after > before;
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
