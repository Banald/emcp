import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import type { Dispatcher } from 'undici';
import { buildDispatchers, type ProxyAgentFactory } from './dispatcher.ts';

describe('buildDispatchers', () => {
  it('returns one dispatcher per URL, in order', () => {
    const factory = mock.fn<ProxyAgentFactory>(() => ({}) as Dispatcher);
    const urls = ['http://a:80', 'http://b:80', 'http://c:80'];
    const dispatchers = buildDispatchers(urls, { connectTimeoutMs: 1000, factory });
    assert.equal(dispatchers.length, 3);
    assert.equal(factory.mock.callCount(), 3);
    assert.deepEqual(
      factory.mock.calls.map((c) => c.arguments[0]),
      urls,
    );
  });

  it('passes connectTimeoutMs through to the factory for every URL', () => {
    const factory = mock.fn<ProxyAgentFactory>(() => ({}) as Dispatcher);
    buildDispatchers(['http://a:80', 'http://b:80'], {
      connectTimeoutMs: 2500,
      factory,
    });
    assert.equal(factory.mock.calls[0].arguments[1], 2500);
    assert.equal(factory.mock.calls[1].arguments[1], 2500);
  });

  it('returns an empty array for an empty URL list (feature-disabled path)', () => {
    const factory = mock.fn<ProxyAgentFactory>(() => ({}) as Dispatcher);
    assert.deepEqual(buildDispatchers([], { connectTimeoutMs: 500, factory }), []);
    assert.equal(factory.mock.callCount(), 0);
  });

  it('uses the default factory (new ProxyAgent) when none is injected', () => {
    // Construct one real ProxyAgent to prove the default factory wires
    // correctly. We immediately close it; the actual network path is
    // covered by the tinyproxy integration test. Runtime check: the
    // returned object exposes the dispatcher-like `close` method.
    const [dispatcher] = buildDispatchers(['http://127.0.0.1:1'], {
      connectTimeoutMs: 500,
    });
    assert.ok(dispatcher !== undefined);
    assert.equal(typeof (dispatcher as unknown as { close: () => unknown }).close, 'function');
    const closePromise = (dispatcher as unknown as { close: () => Promise<void> }).close();
    assert.ok(closePromise instanceof Promise);
    return closePromise;
  });
});
