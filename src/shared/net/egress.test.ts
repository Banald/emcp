import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Dispatcher } from 'undici';
import { TransientError } from '../../lib/errors.ts';
import { classifyError, fetchExternal } from './egress.ts';
import type { ProxyEntry, ProxyOutcome, ProxyPool } from './proxy/types.ts';

const stubDispatcher = (): Dispatcher =>
  ({ close: () => Promise.resolve() }) as unknown as Dispatcher;

function makePool(entries: ProxyEntry[]): {
  pool: ProxyPool;
  nextCalls: number;
  reports: Array<{ id: string; outcome: ProxyOutcome }>;
} {
  let idx = 0;
  const reports: Array<{ id: string; outcome: ProxyOutcome }> = [];
  const pool: ProxyPool = {
    size: entries.length,
    strategy: 'round-robin',
    next: () => entries[idx++ % Math.max(1, entries.length)] ?? null,
    report: (id, outcome) => {
      reports.push({ id, outcome });
    },
    healthSnapshot: () => [],
    healthyCount: () => entries.length,
    close: () => Promise.resolve(),
  };
  const tracker = { pool, nextCalls: 0, reports };
  const wrappedNext = pool.next.bind(pool);
  pool.next = () => {
    tracker.nextCalls++;
    return wrappedNext();
  };
  return tracker;
}

const entry = (id: string): ProxyEntry => ({
  id,
  url: `http://${id}.example.com:8080`,
  dispatcher: stubDispatcher(),
});

function connectErr(code = 'ECONNREFUSED'): Error {
  const err = new Error(`connect: ${code}`);
  (err as { code?: string }).code = code;
  return err;
}

function abortErr(): Error {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

describe('classifyError', () => {
  it('classifies a connect-code error as connect_failure', () => {
    assert.equal(classifyError(connectErr('ECONNREFUSED'), null), 'connect_failure');
    assert.equal(classifyError(connectErr('UND_ERR_CONNECT_TIMEOUT'), null), 'connect_failure');
    assert.equal(classifyError(connectErr('EAI_AGAIN'), null), 'connect_failure');
  });

  it('reads the code from err.cause when the outer err has none', () => {
    const wrapped = new Error('fetch failed');
    (wrapped as { cause?: { code?: string } }).cause = { code: 'ECONNRESET' };
    assert.equal(classifyError(wrapped, null), 'connect_failure');
  });

  it('classifies AbortError / TimeoutError as aborted', () => {
    assert.equal(classifyError(abortErr(), null), 'aborted');
    const timeoutErr = new Error('timed out');
    timeoutErr.name = 'TimeoutError';
    assert.equal(classifyError(timeoutErr, null), 'aborted');
  });

  it('classifies as aborted when the signal is aborted, regardless of error shape', () => {
    const ac = new AbortController();
    ac.abort();
    assert.equal(classifyError(new Error('random'), ac.signal), 'aborted');
  });

  it('falls back to upstream_failure for unrecognised errors', () => {
    assert.equal(classifyError(new Error('weird'), null), 'upstream_failure');
    assert.equal(classifyError('string error', null), 'upstream_failure');
    assert.equal(classifyError(null, null), 'upstream_failure');
  });
});

describe('fetchExternal', () => {
  describe('pool-disabled fast path', () => {
    it('calls fetch directly when the pool is null', async () => {
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
      const res = await fetchExternal('https://api.example.com/x', {}, { pool: null, fetcher });
      assert.equal(res.status, 200);
      assert.equal(fetcher.mock.callCount(), 1);
      // dispatcher must NOT be attached in pool-disabled mode.
      const init = fetcher.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.equal(init.dispatcher, undefined);
    });

    it('calls fetch directly when the pool is empty (size=0)', async () => {
      const { pool } = makePool([]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
      await fetchExternal('https://api.example.com/x', {}, { pool, fetcher });
      assert.equal(fetcher.mock.callCount(), 1);
    });

    it('bypassProxy=true skips the pool entirely even when one is available', async () => {
      const { pool, nextCalls } = makePool([entry('p0')]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok'));
      await fetchExternal('https://api.example.com/x', {}, { pool, fetcher, bypassProxy: true });
      assert.equal(fetcher.mock.callCount(), 1);
      assert.equal(nextCalls, 0);
    });
  });

  describe('successful proxied request', () => {
    it('attaches the dispatcher, reports success, and returns the Response', async () => {
      const { pool, reports } = makePool([entry('p0'), entry('p1')]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok', { status: 200 }));
      const res = await fetchExternal('https://api.example.com/x', {}, { pool, fetcher });
      assert.equal(res.status, 200);
      assert.equal(fetcher.mock.callCount(), 1);
      const init = fetcher.mock.calls[0].arguments[1] as Record<string, unknown>;
      assert.ok(init.dispatcher !== undefined);
      assert.deepEqual(reports, [{ id: 'p0', outcome: 'success' }]);
    });

    it('preserves caller-supplied headers/method alongside the dispatcher', async () => {
      const { pool } = makePool([entry('p0')]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok'));
      await fetchExternal(
        'https://api.example.com/x',
        { method: 'POST', headers: { 'x-test': '1' } },
        { pool, fetcher },
      );
      const init = fetcher.mock.calls[0].arguments[1] as RequestInit & { dispatcher?: unknown };
      assert.equal(init.method, 'POST');
      assert.deepEqual(init.headers, { 'x-test': '1' });
      assert.ok(init.dispatcher !== undefined);
    });

    it('treats upstream 4xx/5xx as success (not a proxy fault)', async () => {
      const { pool, reports } = makePool([entry('p0')]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('nope', { status: 500 }));
      const res = await fetchExternal('https://api.example.com/x', {}, { pool, fetcher });
      assert.equal(res.status, 500);
      assert.deepEqual(reports, [{ id: 'p0', outcome: 'success' }]);
    });
  });

  describe('retry on connect failure', () => {
    it('rotates to the next proxy when the first throws a connect error', async () => {
      const { pool, reports } = makePool([entry('p0'), entry('p1')]);
      let call = 0;
      const fetcher = mock.fn<typeof fetch>(async () => {
        call++;
        if (call === 1) throw connectErr('ECONNREFUSED');
        return new Response('ok', { status: 200 });
      });
      const res = await fetchExternal('https://api.example.com/x', {}, { pool, fetcher });
      assert.equal(res.status, 200);
      assert.equal(fetcher.mock.callCount(), 2);
      assert.deepEqual(reports, [
        { id: 'p0', outcome: 'connect_failure' },
        { id: 'p1', outcome: 'success' },
      ]);
    });

    it('throws TransientError after all proxies fail', async () => {
      const { pool, reports } = makePool([entry('p0'), entry('p1'), entry('p2')]);
      const fetcher = mock.fn<typeof fetch>(async () => {
        throw connectErr('ECONNREFUSED');
      });
      await assert.rejects(
        () => fetchExternal('https://api.example.com/x', {}, { pool, fetcher }),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match((err as Error).message, /proxy attempt\(s\) exhausted/);
          assert.match((err as TransientError).publicMessage, /temporarily unavailable/);
          return true;
        },
      );
      assert.equal(reports.length, 3);
      for (const r of reports) assert.equal(r.outcome, 'connect_failure');
    });

    it('caps retries at EMCP_PROXY_MAX_RETRIES_PER_REQUEST even with more proxies available', async () => {
      // Default test env leaves EMCP_PROXY_MAX_RETRIES_PER_REQUEST=3. A pool
      // of 5 failing proxies should get exactly 3 attempts.
      const { pool, reports } = makePool([
        entry('p0'),
        entry('p1'),
        entry('p2'),
        entry('p3'),
        entry('p4'),
      ]);
      const fetcher = mock.fn<typeof fetch>(async () => {
        throw connectErr('ECONNREFUSED');
      });
      await assert.rejects(
        () => fetchExternal('https://api.example.com/x', {}, { pool, fetcher }),
        TransientError,
      );
      assert.equal(reports.length, 3);
    });

    it('classifies upstream_failure and retries it like connect_failure', async () => {
      // Non-connect error → classified as upstream_failure, still retried
      // (we'd rather briefly cool a proxy that emitted a weird error than
      // hot-loop against it).
      const { pool, reports } = makePool([entry('p0'), entry('p1')]);
      let call = 0;
      const fetcher = mock.fn<typeof fetch>(async () => {
        call++;
        if (call === 1) throw new Error('mysterious');
        return new Response('ok');
      });
      await fetchExternal('https://api.example.com/x', {}, { pool, fetcher });
      assert.equal(reports[0]?.outcome, 'upstream_failure');
      assert.equal(reports[1]?.outcome, 'success');
    });
  });

  describe('abort handling', () => {
    it('throws without retrying when the caller aborts', async () => {
      const { pool, reports } = makePool([entry('p0'), entry('p1')]);
      const ac = new AbortController();
      const fetcher = mock.fn<typeof fetch>(async () => {
        ac.abort();
        throw abortErr();
      });
      await assert.rejects(
        () => fetchExternal('https://api.example.com/x', { signal: ac.signal }, { pool, fetcher }),
        (err: unknown) => err instanceof Error && err.name === 'AbortError',
      );
      // Pool reports the abort and then we exit immediately; no second try.
      assert.equal(fetcher.mock.callCount(), 1);
      assert.deepEqual(reports, [{ id: 'p0', outcome: 'aborted' }]);
    });

    it('treats a pre-aborted signal as aborted even without an AbortError throw', async () => {
      const { pool } = makePool([entry('p0'), entry('p1')]);
      const ac = new AbortController();
      ac.abort();
      const fetcher = mock.fn<typeof fetch>(async () => {
        // Simulate a buggy upstream that throws something else on
        // aborted signal. We should still classify as aborted.
        throw new Error('surprise');
      });
      await assert.rejects(
        () => fetchExternal('https://api.example.com/x', { signal: ac.signal }, { pool, fetcher }),
        (err: unknown) => err instanceof Error && err.message === 'surprise',
      );
      assert.equal(fetcher.mock.callCount(), 1);
    });
  });

  describe('metrics emission', () => {
    const makeMetrics = () => {
      const requests: Array<{ proxy_id: string; status: string }> = [];
      const durations: Array<{ labels: { proxy_id: string }; value: number }> = [];
      const cooldowns: Array<{ proxy_id: string }> = [];
      const healthy: number[] = [];
      return {
        metrics: {
          requestsTotal: {
            inc: (labels: { proxy_id: string; status: string }) => requests.push(labels),
          },
          requestDuration: {
            observe: (labels: { proxy_id: string }, value: number) =>
              durations.push({ labels, value }),
          },
          cooldownsTotal: {
            inc: (labels: { proxy_id: string }) => cooldowns.push(labels),
          },
          poolHealthy: { set: (value: number) => healthy.push(value) },
        },
        requests,
        durations,
        cooldowns,
        healthy,
      };
    };

    it('records a success row + duration + healthy-gauge on a 200', async () => {
      const { pool } = makePool([entry('p0')]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok'));
      let tick = 1_000_000;
      const rec = makeMetrics();
      await fetchExternal(
        'https://api.example.com/x',
        {},
        {
          pool,
          fetcher,
          metrics: rec.metrics,
          now: () => (tick += 50),
        },
      );
      assert.deepEqual(rec.requests, [{ proxy_id: 'p0', status: 'success' }]);
      assert.equal(rec.durations.length, 1);
      assert.equal(rec.durations[0]?.labels.proxy_id, 'p0');
      assert.ok((rec.durations[0]?.value ?? 0) >= 0);
      assert.deepEqual(rec.healthy, [1]);
      assert.equal(rec.cooldowns.length, 0);
    });

    it('emits a cooldown counter on the failure that triggers it (not on every failure)', async () => {
      const { pool } = makePool([entry('p0'), entry('p1')]);
      const fetcher = mock.fn<typeof fetch>(async () => {
        throw connectErr('ECONNREFUSED');
      });
      const rec = makeMetrics();
      await assert.rejects(
        () =>
          fetchExternal('https://api.example.com/x', {}, { pool, fetcher, metrics: rec.metrics }),
        TransientError,
      );
      // makePool uses a hand-rolled stub that doesn't actually cool
      // proxies down (healthSnapshot always returns cooldownUntil=null),
      // so hasNewCooldown returns false. The production pool's cooldown
      // path is tested in src/shared/net/proxy/pool.test.ts. The
      // important assertion here is that requestsTotal increments with
      // the failure label for every attempt. With pool.size=2 and
      // EMCP_PROXY_MAX_RETRIES_PER_REQUEST=3 (test-env default), the budget
      // is clamped to min(3, 2) = 2.
      assert.equal(rec.cooldowns.length, 0);
      const failures = rec.requests.filter((r) => r.status === 'connect_failure');
      assert.equal(failures.length, 2);
    });

    it('emits a cooldown counter when the pool actually schedules one', async () => {
      // Use a real createProxyPool here so the cooldown transition fires
      // as it would in production. Two proxies; the first fails and
      // transitions to cooldown.
      const { createProxyPool } = await import('./proxy/pool.ts');
      const stub = (id: string) => ({
        id,
        url: `http://${id}:80`,
        dispatcher: { close: () => Promise.resolve() } as unknown as import('undici').Dispatcher,
      });
      const pool = createProxyPool([stub('p0'), stub('p1')], {
        strategy: 'round-robin',
        failureCooldownMs: 5_000,
      });
      let call = 0;
      const fetcher = mock.fn<typeof fetch>(async () => {
        call++;
        if (call === 1) throw connectErr('ECONNREFUSED');
        return new Response('ok');
      });
      const rec = makeMetrics();
      await fetchExternal('https://api.example.com/x', {}, { pool, fetcher, metrics: rec.metrics });
      assert.deepEqual(rec.cooldowns, [{ proxy_id: 'p0' }]);
    });

    it('never labels a metric with a proxy URL (cardinality safety)', async () => {
      const { pool } = makePool([entry('p0')]);
      const fetcher = mock.fn<typeof fetch>(async () => new Response('ok'));
      const rec = makeMetrics();
      await fetchExternal('https://api.example.com/x', {}, { pool, fetcher, metrics: rec.metrics });
      for (const r of rec.requests) {
        assert.doesNotMatch(r.proxy_id, /^https?:/);
        assert.doesNotMatch(r.proxy_id, /@/);
      }
      for (const d of rec.durations) {
        assert.doesNotMatch(d.labels.proxy_id, /^https?:/);
      }
    });
  });

  describe('error message safety', () => {
    it('does not leak the full URL (incl. query + credentials) into TransientError', async () => {
      const { pool } = makePool([entry('p0')]);
      const fetcher = mock.fn<typeof fetch>(async () => {
        throw connectErr();
      });
      try {
        await fetchExternal(
          'https://api.example.com/secret/path?token=abc123',
          {},
          { pool, fetcher },
        );
        assert.fail('expected throw');
      } catch (err) {
        assert.ok(err instanceof TransientError);
        assert.doesNotMatch((err as Error).message, /abc123/);
        assert.doesNotMatch((err as Error).message, /secret\/path/);
        assert.match((err as Error).message, /api\.example\.com/);
      }
    });
  });
});
