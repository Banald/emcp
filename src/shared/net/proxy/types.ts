import type { Dispatcher } from 'undici';

/**
 * Type contract for the outbound-proxy subsystem.
 *
 * The pool sits behind the `fetchExternal` wrapper (src/shared/net/egress.ts).
 * Call sites never touch these types directly — they call `fetchExternal`,
 * which asks the pool for the next proxy, dispatches the request, and reports
 * the outcome back. Keeping the types here lets tests import them without
 * pulling in undici's concrete ProxyAgent class.
 */

/** Selection strategy for the next proxy. Matches PROXY_ROTATION env enum. */
export type RotationStrategy = 'round-robin' | 'random';

/**
 * Outcome classes, reported back after each request attempt. The pool only
 * penalises the first two — upstream errors and client aborts say nothing
 * about proxy health.
 */
export type ProxyOutcome = 'success' | 'connect_failure' | 'upstream_failure' | 'aborted';

/**
 * One entry in the pool. `id` is the public label (e.g. "p0"); `url` is
 * the full URL — never serialise it without going through `maskProxyUrl`.
 * `dispatcher` is the undici `ProxyAgent` that `fetch` should dispatch
 * through; it is owned by the pool and closed on shutdown.
 */
export interface ProxyEntry {
  readonly id: string;
  readonly url: string;
  readonly dispatcher: Dispatcher;
}

/** Per-entry health state, visible to tests and to the health gauge. */
export interface ProxyHealth {
  readonly id: string;
  /** Milliseconds since epoch of the last connect/upstream failure, or null. */
  readonly lastFailureAt: number | null;
  /** Milliseconds since epoch after which the proxy rejoins rotation. */
  readonly cooldownUntil: number | null;
  /** Consecutive failure count since the last success. */
  readonly consecutiveFailures: number;
  /** True iff `cooldownUntil > now()`. */
  readonly inCooldown: boolean;
}

/** Public contract of the pool. */
export interface ProxyPool {
  readonly size: number;
  readonly strategy: RotationStrategy;
  /**
   * Return the next entry eligible for use. Skips cooldown-ed entries unless
   * every entry is cooled down, in which case it returns the one with the
   * oldest cooldown (last-ditch). Returns `null` only if `size === 0`, which
   * callers should pre-check — a zero-size pool means "feature disabled" and
   * `fetchExternal` never calls `next()` on it.
   */
  next(): ProxyEntry | null;
  /**
   * Report the outcome of a request attempt. Only `connect_failure` and
   * `upstream_failure` update health — the pool uses the same cooldown policy
   * for both (neither is fatal; both bypass this entry for N ms).
   */
  report(entryId: string, outcome: ProxyOutcome): void;
  /** Snapshot of all entries' health. Tests + metrics consume this. */
  healthSnapshot(): readonly ProxyHealth[];
  /** Count of entries currently eligible for rotation (not in cooldown). */
  healthyCount(): number;
  /** Close every dispatcher, freeing sockets. Registered for shutdown. */
  close(): Promise<void>;
}
