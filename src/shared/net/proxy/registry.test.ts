import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { Dispatcher } from 'undici';
import {
  __setProxyPoolForTesting,
  buildPoolEntries,
  buildPoolFromConfig,
  getProxyPool,
  type PoolBuildConfig,
} from './registry.ts';
import type { ProxyPool } from './types.ts';

const stubDispatcher = (): Dispatcher => ({ close: () => Promise.resolve() }) as unknown as Dispatcher;

const baseCfg: PoolBuildConfig = Object.freeze({
  proxyUrls: Object.freeze(['http://p0.example.com:8080', 'http://p1.example.com:8080']),
  proxyRotation: 'round-robin',
  proxyFailureCooldownMs: 5000,
  proxyConnectTimeoutMs: 1000,
});

describe('buildPoolEntries', () => {
  it('assigns sequential p<index> ids to each URL', () => {
    const factory = mock.fn(() => stubDispatcher());
    const entries = buildPoolEntries(
      ['http://a:80', 'http://b:80', 'http://c:80'],
      500,
      { factory },
    );
    assert.deepEqual(
      entries.map((e) => e.id),
      ['p0', 'p1', 'p2'],
    );
    assert.deepEqual(
      entries.map((e) => e.url),
      ['http://a:80', 'http://b:80', 'http://c:80'],
    );
    assert.equal(factory.mock.callCount(), 3);
  });

  it('returns an empty array when given an empty URL list', () => {
    const factory = mock.fn(() => stubDispatcher());
    assert.deepEqual(buildPoolEntries([], 500, { factory }), []);
    assert.equal(factory.mock.callCount(), 0);
  });

  it('wires the same connectTimeoutMs to every factory call', () => {
    const factory = mock.fn(() => stubDispatcher());
    buildPoolEntries(['http://a:80', 'http://b:80'], 1234, { factory });
    assert.equal(factory.mock.calls[0].arguments[1], 1234);
    assert.equal(factory.mock.calls[1].arguments[1], 1234);
  });
});

describe('buildPoolFromConfig', () => {
  it('returns null when the URL list is empty', () => {
    const pool = buildPoolFromConfig({ ...baseCfg, proxyUrls: [] });
    assert.equal(pool, null);
  });

  it('returns a working pool when URLs are present', () => {
    const factory = mock.fn(() => stubDispatcher());
    const pool = buildPoolFromConfig(baseCfg, { factory });
    assert.ok(pool !== null);
    assert.equal(pool.size, 2);
    assert.equal(pool.strategy, 'round-robin');
    assert.equal(pool.next()?.id, 'p0');
    assert.equal(pool.next()?.id, 'p1');
  });

  it('threads proxyRotation through to the constructed pool', () => {
    const factory = mock.fn(() => stubDispatcher());
    const pool = buildPoolFromConfig({ ...baseCfg, proxyRotation: 'random' }, { factory });
    assert.equal(pool?.strategy, 'random');
  });

  it('threads failureCooldownMs through so cooldown uses the configured window', () => {
    const factory = mock.fn(() => stubDispatcher());
    const pool = buildPoolFromConfig({ ...baseCfg, proxyFailureCooldownMs: 2000 }, { factory });
    assert.ok(pool !== null);
    pool.report('p0', 'connect_failure');
    const [h] = pool.healthSnapshot();
    // cooldownUntil = now + 2000ms. now() uses Date.now under the hood
    // here — we check the window, not an exact instant.
    const cooldown = (h?.cooldownUntil ?? 0) - Date.now();
    assert.ok(cooldown > 1500 && cooldown <= 2000, `cooldown window unexpected: ${cooldown}`);
  });
});

describe('getProxyPool (singleton)', () => {
  beforeEach(() => {
    __setProxyPoolForTesting(undefined);
  });

  afterEach(() => {
    __setProxyPoolForTesting(undefined);
  });

  it('returns null when config.proxyUrls is empty (default test env)', () => {
    // Default test env sets PROXY_URLS='' so the singleton path builds null.
    assert.equal(getProxyPool(), null);
  });

  it('memoises the null result across calls', () => {
    const first = getProxyPool();
    const second = getProxyPool();
    assert.equal(first, null);
    assert.equal(second, null);
  });

  it('honours an externally-provided pool via __setProxyPoolForTesting', () => {
    const fake = { size: 99 } as unknown as ProxyPool;
    __setProxyPoolForTesting(fake);
    assert.equal(getProxyPool(), fake);
  });

  it('accepts __setProxyPoolForTesting(null) as an explicit "disabled" cache', () => {
    __setProxyPoolForTesting(null);
    assert.equal(getProxyPool(), null);
  });

  it('accepts __setProxyPoolForTesting(undefined) as a cache reset', () => {
    __setProxyPoolForTesting({ size: 1 } as unknown as ProxyPool);
    __setProxyPoolForTesting(undefined);
    // Default config still has empty PROXY_URLS → rebuild returns null.
    assert.equal(getProxyPool(), null);
  });
});
