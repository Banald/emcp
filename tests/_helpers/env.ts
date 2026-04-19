// Shared env defaults for tests. Single source of truth for what a "test
// environment" env block looks like; any new required var in src/config.ts
// gets added here once rather than in four independently drifting callers.

export const DEFAULT_TEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'test',
  EMCP_PORT: '3000',
  EMCP_BIND_HOST: '127.0.0.1',
  EMCP_PUBLIC_HOST: 'localhost:3000',
  EMCP_ALLOWED_ORIGINS: 'http://localhost:3000',
  EMCP_DATABASE_URL: 'postgres://mcp:mcp@localhost:5432/mcp_test',
  EMCP_DATABASE_POOL_MAX: '5',
  EMCP_REDIS_URL: 'redis://localhost:6379',
  EMCP_API_KEY_HMAC_SECRET: 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==',
  EMCP_LOG_LEVEL: 'silent',
  EMCP_RATE_LIMIT_DEFAULT_PER_MINUTE: '60',
  EMCP_SHUTDOWN_TIMEOUT_MS: '5000',
  EMCP_SEARXNG_URL: 'http://localhost:8080',
  // Low session cap so the per-key cap test (AUDIT M-1) can exercise the
  // limit in a handful of requests. `rate-limit-http.test.ts` pushes 7
  // initialize POSTs through one key, so the cap has to sit above that
  // (rate-limit test scenarios can't silently trip the session cap).
  EMCP_MCP_MAX_SESSIONS_PER_KEY: '10',
  // Low enough that the global-cap test can reach it across distinct
  // keys in a handful of requests, but high enough that no existing
  // single-key test tripping its per-key cap (10) brushes up against it.
  EMCP_MCP_MAX_SESSIONS_TOTAL: '20',
  // AUDIT L-5 — set explicitly so the server.test.ts assertion can
  // anchor on a known value independent of the Node default (300s).
  EMCP_HTTP_REQUEST_TIMEOUT_MS: '60000',
  // Outbound-proxy rotation (docs/ARCHITECTURE.md "Proxy egress"):
  // empty EMCP_PROXY_URLS keeps the feature disabled so every existing
  // test runs fetchExternal's bypass path. Integration tests that
  // exercise the pool-active path build their own pool explicitly —
  // they don't rely on this env var.
  EMCP_PROXY_URLS: '',
});

/**
 * Fill every required env var that isn't already set in process.env.
 * Idempotent — never overwrites values the caller (or a preceding test hook)
 * has already placed. Meant for use from `tests/setup.ts` which runs once
 * before any test file loads.
 */
export function applyDefaultTestEnv(): void {
  for (const [key, value] of Object.entries(DEFAULT_TEST_ENV)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Build a plain env object for handing to `spawn(child, { env })` in
 * integration tests. Starts from `DEFAULT_TEST_ENV`, applies per-test
 * overrides, and preserves `PATH` / `HOME` from the parent shell so the
 * child can find `node`.
 */
export function buildTestEnv(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  return {
    ...DEFAULT_TEST_ENV,
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    ...overrides,
  };
}
