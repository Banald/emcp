import type { Dispatcher } from 'undici';
import { ProxyAgent } from 'undici';

/**
 * Builds undici `ProxyAgent` instances for proxy URLs. Agents are fairly
 * expensive (each owns its own socket pool + keep-alive state), so we cache
 * one per URL; the pool hands out references and never reconstructs.
 *
 * The factory is a thin wrapper so tests can inject a mock `ProxyAgent` via
 * `createProxyDispatcher({ factory })` instead of spawning a real socket pool.
 */

export type ProxyAgentFactory = (url: string, connectTimeoutMs: number) => Dispatcher;

const defaultFactory: ProxyAgentFactory = (url, connectTimeoutMs) =>
  new ProxyAgent({
    uri: url,
    connectTimeout: connectTimeoutMs,
  });

export interface BuildDispatchersOptions {
  readonly connectTimeoutMs: number;
  readonly factory?: ProxyAgentFactory;
}

/**
 * Construct one `Dispatcher` per URL in order. Returns the dispatchers in
 * the same order so the pool's `id = "p<index>"` labelling stays stable.
 */
export function buildDispatchers(
  urls: readonly string[],
  options: BuildDispatchersOptions,
): Dispatcher[] {
  const factory = options.factory ?? defaultFactory;
  return urls.map((url) => factory(url, options.connectTimeoutMs));
}
