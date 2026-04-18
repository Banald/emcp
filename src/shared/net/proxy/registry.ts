import { config } from '../../../config.ts';
import { logger } from '../../../lib/logger.ts';
import { registerShutdown } from '../../../lib/shutdown.ts';
import { buildDispatchers, type ProxyAgentFactory } from './dispatcher.ts';
import { createProxyPool } from './pool.ts';
import { maskProxyUrl } from './redact.ts';
import type { ProxyEntry, ProxyPool } from './types.ts';

/**
 * Singleton registration of the proxy pool.
 *
 * The pool lives for the lifetime of the process. First caller builds it
 * from `config.proxyUrls`; subsequent callers reuse it. When PROXY_URLS is
 * empty the singleton is `null` — `fetchExternal` treats this as the
 * fast-path "pool disabled" marker and calls `fetch` directly.
 *
 * `__setProxyPoolForTesting` matches the test seam used by
 * `src/lib/redis.ts::__setRedisForTesting` and
 * `src/shared/net/http.ts::__setDefaultPinnedFetcherForTesting`.
 *
 * The pure `buildPoolEntries` / `buildPoolFromConfig` functions below
 * are exported so tests can cover the non-empty-URLs path without having
 * to reload the frozen `config` module.
 */

let singleton: ProxyPool | null | undefined;

export interface BuildPoolOptions {
  readonly factory?: ProxyAgentFactory;
}

/**
 * Construct ProxyEntry objects (id + url + dispatcher) for a URL list.
 * Pure: no side effects, no process-level state.
 */
export function buildPoolEntries(
  urls: readonly string[],
  connectTimeoutMs: number,
  options: BuildPoolOptions = {},
): ProxyEntry[] {
  const dispatchers = buildDispatchers(urls, {
    connectTimeoutMs,
    factory: options.factory,
  });
  return urls.map((url, index) => {
    const dispatcher = dispatchers[index];
    if (dispatcher === undefined) {
      // `buildDispatchers` returns exactly `urls.length` entries; this
      // branch is structurally unreachable but keeps TS happy.
      throw new Error(`proxy registry: missing dispatcher for index ${index}`);
    }
    return { id: `p${index}`, url, dispatcher };
  });
}

/**
 * A trimmed subset of `Config` used by `buildPoolFromConfig`. Keeps the
 * build path testable without forcing tests to construct the full Config
 * object (which freezes at import time from process.env).
 */
export interface PoolBuildConfig {
  readonly proxyUrls: readonly string[];
  readonly proxyRotation: 'round-robin' | 'random';
  readonly proxyFailureCooldownMs: number;
  readonly proxyConnectTimeoutMs: number;
}

/**
 * Build a pool from a config-shaped input. Returns `null` when
 * `proxyUrls` is empty (the feature-disabled marker).
 */
export function buildPoolFromConfig(
  cfg: PoolBuildConfig,
  options: BuildPoolOptions = {},
): ProxyPool | null {
  if (cfg.proxyUrls.length === 0) return null;
  const entries = buildPoolEntries(cfg.proxyUrls, cfg.proxyConnectTimeoutMs, options);
  return createProxyPool(entries, {
    strategy: cfg.proxyRotation,
    failureCooldownMs: cfg.proxyFailureCooldownMs,
  });
}

/**
 * Return the active pool, or `null` if the feature is disabled.
 * The pool is constructed lazily on first call.
 */
export function getProxyPool(options?: BuildPoolOptions): ProxyPool | null {
  if (singleton !== undefined) return singleton;
  const pool = buildPoolFromConfig(config, options);
  singleton = pool;
  if (pool !== null) {
    registerShutdown('proxy-pool', () => pool.close());
    logger.info(
      { proxies: config.proxyUrls.map(maskProxyUrl), strategy: pool.strategy, size: pool.size },
      'proxy pool initialised',
    );
  }
  return pool;
}

/**
 * Test-only hook: replace or clear the cached singleton. Passing a
 * concrete pool replaces the production one for the duration of a test;
 * passing `null` memoises the disabled marker; passing `undefined` (the
 * default reset form) clears the cache so the next `getProxyPool()`
 * rebuilds from current config.
 */
export function __setProxyPoolForTesting(pool: ProxyPool | null | undefined): void {
  singleton = pool;
}
