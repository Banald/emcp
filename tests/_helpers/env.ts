// Shared env defaults for tests. Single source of truth for what a "test
// environment" env block looks like; any new required var in src/config.ts
// gets added here once rather than in four independently drifting callers.

export const DEFAULT_TEST_ENV: Readonly<Record<string, string>> = Object.freeze({
  NODE_ENV: 'test',
  PORT: '3000',
  BIND_HOST: '127.0.0.1',
  PUBLIC_HOST: 'localhost:3000',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgres://mcp:mcp@localhost:5432/mcp_test',
  DATABASE_POOL_MAX: '5',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_HMAC_SECRET: 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_DEFAULT_PER_MINUTE: '60',
  SHUTDOWN_TIMEOUT_MS: '5000',
  SEARXNG_URL: 'http://localhost:8080',
  // Low session cap so the per-key cap test (AUDIT M-1) can exercise the
  // limit in a handful of requests. Other tests create at most 2 sessions
  // per key, so this headroom is plenty for them.
  MCP_MAX_SESSIONS_PER_KEY: '4',
  MCP_MAX_SESSIONS_TOTAL: '100',
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
