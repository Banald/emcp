import type {
  ProxyEntry,
  ProxyHealth,
  ProxyOutcome,
  ProxyPool,
  RotationStrategy,
} from './types.ts';

export interface CreatePoolOptions {
  readonly strategy: RotationStrategy;
  readonly failureCooldownMs: number;
  /**
   * Failures required before a proxy is cooled down. Default 1 —
   * a single failed hop parks the proxy for `failureCooldownMs`, which
   * matches the "drain the upstream complaint fast" posture the plan
   * locks in. Tests override to exercise the threshold branch.
   */
  readonly failureThreshold?: number;
  /** Test-only seam: overrideable time source for cooldown arithmetic. */
  readonly now?: () => number;
  /** Test-only seam: random selector for the `random` strategy. */
  readonly random?: () => number;
}

interface PoolEntry {
  readonly entry: ProxyEntry;
  lastFailureAt: number | null;
  cooldownUntil: number | null;
  consecutiveFailures: number;
}

/**
 * In-memory rotating proxy pool. Single-process; per-worker cron and per-server
 * HTTP handlers share one pool instance via `src/shared/net/proxy/registry.ts`.
 *
 * Scheduling guarantees:
 *   - `round-robin` advances deterministically; skipping cooled-down entries
 *     preserves the order of the remaining healthy set.
 *   - `random` picks uniformly among healthy entries; falls back to uniform
 *     among all entries when nothing is healthy.
 *   - When every entry is cooled down, `next()` returns the entry whose
 *     cooldown expires soonest. That's the least-bad fallback — the caller's
 *     retry budget will still try the whole set before surfacing failure.
 *
 * Concurrency: Node is single-threaded per event loop, and `next()` /
 * `report()` are both synchronous. No locking needed.
 */
export function createProxyPool(
  entries: readonly ProxyEntry[],
  options: CreatePoolOptions,
): ProxyPool {
  const items: PoolEntry[] = entries.map((entry) => ({
    entry,
    lastFailureAt: null,
    cooldownUntil: null,
    consecutiveFailures: 0,
  }));
  const size = items.length;
  const strategy = options.strategy;
  const failureCooldownMs = options.failureCooldownMs;
  const failureThreshold = options.failureThreshold ?? 1;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;

  // Round-robin cursor. Pointed *past* the last item returned so the next
  // call advances naturally. Never leaks outside the closure; keeps test
  // determinism since the only mutation is here.
  let rrCursor = 0;

  const isHealthy = (item: PoolEntry, t: number): boolean => {
    if (item.cooldownUntil === null) return true;
    return item.cooldownUntil <= t;
  };

  const healthyIndices = (t: number): number[] => {
    const out: number[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item !== undefined && isHealthy(item, t)) out.push(i);
    }
    return out;
  };

  // Fallback picker: when every entry is cooled down, pick the one whose
  // cooldown expires soonest. Tied entries break by index.
  const earliestCooldownIndex = (): number => {
    let best = 0;
    let bestDeadline = items[0]?.cooldownUntil ?? 0;
    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      if (item === undefined) continue;
      const d = item.cooldownUntil ?? 0;
      if (d < bestDeadline) {
        best = i;
        bestDeadline = d;
      }
    }
    return best;
  };

  const pickRoundRobin = (healthy: readonly number[]): number => {
    // Find the next healthy index at or after rrCursor. The modulo keeps the
    // cursor bounded even as entries cool in and out of the healthy set.
    for (let offset = 0; offset < size; offset++) {
      const candidate = (rrCursor + offset) % size;
      if (healthy.includes(candidate)) {
        rrCursor = (candidate + 1) % size;
        return candidate;
      }
    }
    // Should be unreachable — caller pre-checks `healthy.length > 0`.
    return healthy[0] ?? 0;
  };

  const pickRandom = (healthy: readonly number[]): number => {
    const r = Math.floor(random() * healthy.length);
    return healthy[Math.min(r, healthy.length - 1)] ?? 0;
  };

  const next = (): ProxyEntry | null => {
    if (size === 0) return null;
    const t = now();
    const healthy = healthyIndices(t);
    let chosenIdx: number;
    if (healthy.length === 0) {
      chosenIdx = earliestCooldownIndex();
    } else if (strategy === 'random') {
      chosenIdx = pickRandom(healthy);
    } else {
      chosenIdx = pickRoundRobin(healthy);
    }
    const chosen = items[chosenIdx];
    // `items` is populated from a finite `entries` array above; this branch
    // is structurally unreachable (size > 0 && chosenIdx < size) but keeps
    // the TypeScript refinement narrow.
    if (chosen === undefined) return null;
    return chosen.entry;
  };

  const reportById = (id: string, outcome: ProxyOutcome): void => {
    const item = items.find((candidate) => candidate.entry.id === id);
    if (item === undefined) return;

    if (outcome === 'success') {
      item.consecutiveFailures = 0;
      item.cooldownUntil = null;
      // Keep `lastFailureAt` so operators can still see the history in the
      // health snapshot — it's only cleared when the pool rebuilds.
      return;
    }
    if (outcome === 'aborted') {
      // Abort says nothing about the proxy. Don't tick the counter.
      return;
    }
    // connect_failure / upstream_failure
    const t = now();
    item.lastFailureAt = t;
    item.consecutiveFailures += 1;
    if (item.consecutiveFailures >= failureThreshold) {
      item.cooldownUntil = t + failureCooldownMs;
    }
  };

  const healthSnapshot = (): readonly ProxyHealth[] => {
    const t = now();
    return items.map((item) => ({
      id: item.entry.id,
      lastFailureAt: item.lastFailureAt,
      cooldownUntil: item.cooldownUntil,
      consecutiveFailures: item.consecutiveFailures,
      inCooldown: item.cooldownUntil !== null && item.cooldownUntil > t,
    }));
  };

  const healthyCount = (): number => healthyIndices(now()).length;

  const close = async (): Promise<void> => {
    await Promise.all(
      items.map(async (item) => {
        const dispatcher = item.entry.dispatcher as unknown as { close?: () => Promise<void> };
        if (typeof dispatcher.close === 'function') {
          try {
            await dispatcher.close();
          } catch {
            // Closing a dispatcher is best-effort during shutdown — a
            // half-open socket isn't worth aborting the shutdown path.
          }
        }
      }),
    );
  };

  return {
    size,
    strategy,
    next,
    report: reportById,
    healthSnapshot,
    healthyCount,
    close,
  };
}
