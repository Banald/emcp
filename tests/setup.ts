// Preloaded via `node --test --import ./tests/setup.ts`.
// Populates every required env var with a safe test default so modules that load config
// at import time (logger, db client, redis factories, shutdown) can be tested without a .env file.

const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  BIND_HOST: '127.0.0.1',
  PUBLIC_HOST: 'localhost:3000',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  DATABASE_URL: 'postgres://mcp:mcp@localhost:5432/mcp_test',
  DATABASE_POOL_MAX: '5',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_HMAC_SECRET: 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==',
  RATE_LIMIT_DEFAULT_PER_MINUTE: '60',
  WORKER_CONCURRENCY: '3',
  SHUTDOWN_TIMEOUT_MS: '5000',
  SEARXNG_URL: 'http://localhost:8080',
};

for (const [key, value] of Object.entries(defaults)) {
  if (process.env[key] === undefined) process.env[key] = value;
}
