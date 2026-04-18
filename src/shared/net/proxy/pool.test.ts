import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Dispatcher } from 'undici';
import { createProxyPool } from './pool.ts';
import type { ProxyEntry } from './types.ts';

// Stand-in dispatcher. The pool never calls dispatcher methods outside
// `close()`; on its own, `close()` is optional. Two flavours below:
// one that records calls and one that throws on close.
const stubDispatcher = (recorder?: { closed: number }): Dispatcher =>
  ({
    close: () => {
      if (recorder !== undefined) recorder.closed += 1;
      return Promise.resolve();
    },
  }) as unknown as Dispatcher;

const entry = (id: string): ProxyEntry => ({
  id,
  url: `http://${id}.example.com:8080`,
  dispatcher: stubDispatcher(),
});

describe('createProxyPool', () => {
  describe('size + strategy', () => {
    it('reports size and strategy via the returned pool', () => {
      const pool = createProxyPool([entry('p0'), entry('p1')], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
      });
      assert.equal(pool.size, 2);
      assert.equal(pool.strategy, 'round-robin');
    });

    it('reports size 0 when built from an empty list', () => {
      const pool = createProxyPool([], { strategy: 'round-robin', failureCooldownMs: 1000 });
      assert.equal(pool.size, 0);
      assert.equal(pool.next(), null);
    });
  });

  describe('round-robin', () => {
    it('cycles deterministically through every entry', () => {
      const pool = createProxyPool([entry('p0'), entry('p1'), entry('p2')], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
      });
      assert.equal(pool.next()?.id, 'p0');
      assert.equal(pool.next()?.id, 'p1');
      assert.equal(pool.next()?.id, 'p2');
      assert.equal(pool.next()?.id, 'p0'); // wraps
    });

    it('skips entries in cooldown while the healthy set is non-empty', () => {
      const t = 1_000_000;
      const pool = createProxyPool([entry('p0'), entry('p1'), entry('p2')], {
        strategy: 'round-robin',
        failureCooldownMs: 60_000,
        now: () => t,
      });
      pool.report('p1', 'connect_failure');
      assert.equal(pool.next()?.id, 'p0');
      assert.equal(pool.next()?.id, 'p2');
      assert.equal(pool.next()?.id, 'p0'); // p1 still skipped
    });

    it('rejoins a cooled-down entry once its cooldown has expired', () => {
      let t = 0;
      const pool = createProxyPool([entry('p0'), entry('p1')], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
        now: () => t,
      });
      pool.report('p0', 'connect_failure');
      assert.equal(pool.next()?.id, 'p1');
      t += 2000; // cooldown expired
      assert.equal(pool.next()?.id, 'p0');
    });
  });

  describe('random', () => {
    it('picks uniformly among healthy entries using the injected random source', () => {
      // random() returns successive values from [0, 0.4, 0.8]. Multiplied by
      // healthy.length = 2, yields indexes 0, 0, 1. Thus first two calls
      // should both land on p0, third on p1.
      const values = [0, 0.4, 0.8];
      let i = 0;
      const pool = createProxyPool([entry('p0'), entry('p1')], {
        strategy: 'random',
        failureCooldownMs: 1000,
        random: () => values[i++] ?? 0,
      });
      assert.equal(pool.next()?.id, 'p0');
      assert.equal(pool.next()?.id, 'p0');
      assert.equal(pool.next()?.id, 'p1');
    });

    it('never returns a cooled-down entry while a healthy one remains', () => {
      const t = 0;
      const pool = createProxyPool([entry('p0'), entry('p1')], {
        strategy: 'random',
        failureCooldownMs: 1000,
        now: () => t,
        random: () => 0.99, // would pick last index if both healthy
      });
      pool.report('p1', 'connect_failure');
      for (let n = 0; n < 5; n++) assert.equal(pool.next()?.id, 'p0');
    });
  });

  describe('cooldown fallback', () => {
    it('returns the earliest-expiring entry when every entry is cooled', () => {
      let t = 0;
      const pool = createProxyPool([entry('p0'), entry('p1')], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
        now: () => t,
      });
      pool.report('p0', 'connect_failure'); // cooldownUntil = 1000
      t += 10;
      pool.report('p1', 'connect_failure'); // cooldownUntil = 1010
      // Neither is healthy; next() returns p0 (earliest cooldown).
      assert.equal(pool.next()?.id, 'p0');
    });
  });

  describe('report outcomes', () => {
    it('clears cooldown and counter on success', () => {
      const t = 0;
      const pool = createProxyPool([entry('p0')], {
        strategy: 'round-robin',
        failureCooldownMs: 5000,
        now: () => t,
      });
      pool.report('p0', 'connect_failure');
      pool.report('p0', 'connect_failure');
      pool.report('p0', 'success');
      const [h] = pool.healthSnapshot();
      assert.ok(h !== undefined);
      assert.equal(h.consecutiveFailures, 0);
      assert.equal(h.cooldownUntil, null);
      // lastFailureAt is retained for operator visibility.
      assert.notEqual(h.lastFailureAt, null);
    });

    it('does not penalise on abort', () => {
      const pool = createProxyPool([entry('p0')], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
      });
      pool.report('p0', 'aborted');
      const [h] = pool.healthSnapshot();
      assert.ok(h !== undefined);
      assert.equal(h.consecutiveFailures, 0);
      assert.equal(h.cooldownUntil, null);
      assert.equal(h.lastFailureAt, null);
    });

    it('requires failureThreshold hits before cooling down', () => {
      const t = 1000;
      const pool = createProxyPool([entry('p0')], {
        strategy: 'round-robin',
        failureCooldownMs: 5000,
        failureThreshold: 2,
        now: () => t,
      });
      pool.report('p0', 'connect_failure');
      assert.equal(pool.healthSnapshot()[0]?.cooldownUntil, null);
      pool.report('p0', 'connect_failure');
      assert.equal(pool.healthSnapshot()[0]?.cooldownUntil, 6000);
    });

    it('ignores reports for unknown ids', () => {
      const pool = createProxyPool([entry('p0')], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
      });
      pool.report('ghost', 'connect_failure');
      assert.equal(pool.healthSnapshot().length, 1);
      assert.equal(pool.healthSnapshot()[0]?.consecutiveFailures, 0);
    });
  });

  describe('healthyCount + healthSnapshot', () => {
    it('reports healthy entries as the count (excluding cooled)', () => {
      let t = 0;
      const pool = createProxyPool([entry('p0'), entry('p1'), entry('p2')], {
        strategy: 'round-robin',
        failureCooldownMs: 10,
        now: () => t,
      });
      assert.equal(pool.healthyCount(), 3);
      pool.report('p1', 'connect_failure');
      assert.equal(pool.healthyCount(), 2);
      t += 100;
      assert.equal(pool.healthyCount(), 3); // cooldown expired
    });

    it('snapshot inCooldown flips false when time advances past cooldownUntil', () => {
      let t = 0;
      const pool = createProxyPool([entry('p0')], {
        strategy: 'round-robin',
        failureCooldownMs: 10,
        now: () => t,
      });
      pool.report('p0', 'connect_failure');
      assert.equal(pool.healthSnapshot()[0]?.inCooldown, true);
      t += 20;
      assert.equal(pool.healthSnapshot()[0]?.inCooldown, false);
    });
  });

  describe('close', () => {
    it('calls close() on every dispatcher', async () => {
      const rec0 = { closed: 0 };
      const rec1 = { closed: 0 };
      const pool = createProxyPool(
        [
          { id: 'p0', url: 'http://a:80', dispatcher: stubDispatcher(rec0) },
          { id: 'p1', url: 'http://b:80', dispatcher: stubDispatcher(rec1) },
        ],
        { strategy: 'round-robin', failureCooldownMs: 1000 },
      );
      await pool.close();
      assert.equal(rec0.closed, 1);
      assert.equal(rec1.closed, 1);
    });

    it('swallows dispatcher close() failures', async () => {
      const throwing = {
        close: () => Promise.reject(new Error('boom')),
      } as unknown as Dispatcher;
      const pool = createProxyPool([{ id: 'p0', url: 'http://a:80', dispatcher: throwing }], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
      });
      await assert.doesNotReject(pool.close());
    });

    it('tolerates dispatchers without a close() method', async () => {
      const noClose = {} as unknown as Dispatcher;
      const pool = createProxyPool([{ id: 'p0', url: 'http://a:80', dispatcher: noClose }], {
        strategy: 'round-robin',
        failureCooldownMs: 1000,
      });
      await assert.doesNotReject(pool.close());
    });
  });
});
