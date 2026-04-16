import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';
import { ConfigError, isAppError } from './lib/errors.ts';

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  PORT: '3000',
  BIND_HOST: '127.0.0.1',
  PUBLIC_HOST: 'mcp.example.com',
  ALLOWED_ORIGINS: 'https://a.example.com,https://b.example.com',
  DATABASE_URL: 'postgres://u:p@localhost:5432/mcp',
  DATABASE_POOL_MAX: '20',
  REDIS_URL: 'redis://localhost:6379',
  API_KEY_HMAC_SECRET: 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==',
  LOG_LEVEL: 'info',
  RATE_LIMIT_DEFAULT_PER_MINUTE: '120',
  WORKER_CONCURRENCY: '4',
  SHUTDOWN_TIMEOUT_MS: '20000',
});

describe('loadConfig', () => {
  describe('happy path', () => {
    it('parses a fully-populated env and returns a frozen Config', () => {
      const config = loadConfig(validEnv());
      assert.equal(config.nodeEnv, 'production');
      assert.equal(config.port, 3000);
      assert.equal(config.bindHost, '127.0.0.1');
      assert.equal(config.publicHost, 'mcp.example.com');
      assert.deepEqual(
        [...config.allowedOrigins],
        ['https://a.example.com', 'https://b.example.com'],
      );
      assert.equal(config.databaseUrl, 'postgres://u:p@localhost:5432/mcp');
      assert.equal(config.databasePoolMax, 20);
      assert.equal(config.redisUrl, 'redis://localhost:6379');
      assert.equal(config.apiKeyHmacSecret, 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==');
      assert.equal(config.logLevel, 'info');
      assert.equal(config.rateLimitDefaultPerMinute, 120);
      assert.equal(config.workerConcurrency, 4);
      assert.equal(config.shutdownTimeoutMs, 20000);
      assert.equal(Object.isFrozen(config), true);
      assert.equal(Object.isFrozen(config.allowedOrigins), true);
    });

    it('coerces integer env values to numbers', () => {
      const config = loadConfig(validEnv());
      assert.equal(typeof config.port, 'number');
      assert.equal(typeof config.databasePoolMax, 'number');
      assert.equal(typeof config.shutdownTimeoutMs, 'number');
    });
  });

  describe('defaults', () => {
    it('applies BIND_HOST default when unset', () => {
      const env = validEnv();
      delete env.BIND_HOST;
      const config = loadConfig(env);
      assert.equal(config.bindHost, '127.0.0.1');
    });

    it('applies DATABASE_POOL_MAX / rate limit / worker / shutdown defaults', () => {
      const env = validEnv();
      delete env.DATABASE_POOL_MAX;
      delete env.RATE_LIMIT_DEFAULT_PER_MINUTE;
      delete env.WORKER_CONCURRENCY;
      delete env.SHUTDOWN_TIMEOUT_MS;
      const config = loadConfig(env);
      assert.equal(config.databasePoolMax, 10);
      assert.equal(config.rateLimitDefaultPerMinute, 60);
      assert.equal(config.workerConcurrency, 3);
      assert.equal(config.shutdownTimeoutMs, 30000);
    });

    it('defaults LOG_LEVEL to debug in development', () => {
      const env = validEnv();
      env.NODE_ENV = 'development';
      delete env.LOG_LEVEL;
      assert.equal(loadConfig(env).logLevel, 'debug');
    });

    it('defaults LOG_LEVEL to info in production', () => {
      const env = validEnv();
      env.NODE_ENV = 'production';
      delete env.LOG_LEVEL;
      assert.equal(loadConfig(env).logLevel, 'info');
    });

    it('defaults LOG_LEVEL to info in test', () => {
      const env = validEnv();
      env.NODE_ENV = 'test';
      delete env.LOG_LEVEL;
      assert.equal(loadConfig(env).logLevel, 'info');
    });

    it('respects an explicit LOG_LEVEL override regardless of NODE_ENV', () => {
      const env = validEnv();
      env.NODE_ENV = 'development';
      env.LOG_LEVEL = 'warn';
      assert.equal(loadConfig(env).logLevel, 'warn');
    });

    it('applies SEARXNG_URL default when unset', () => {
      const env = validEnv();
      delete env.SEARXNG_URL;
      const config = loadConfig(env);
      assert.equal(config.searxngUrl, 'http://localhost:8080');
    });

    it('strips trailing slashes from SEARXNG_URL', () => {
      const env = validEnv();
      env.SEARXNG_URL = 'http://localhost:8080///';
      const config = loadConfig(env);
      assert.equal(config.searxngUrl, 'http://localhost:8080');
    });
  });

  describe('ALLOWED_ORIGINS parsing', () => {
    it('splits on comma and trims whitespace', () => {
      const env = validEnv();
      env.ALLOWED_ORIGINS =
        '  https://a.example.com , https://b.example.com  ,https://c.example.com';
      const config = loadConfig(env);
      assert.deepEqual(
        [...config.allowedOrigins],
        ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'],
      );
    });

    it('drops empty entries produced by stray commas', () => {
      const env = validEnv();
      env.ALLOWED_ORIGINS = 'https://a.example.com,,https://b.example.com,';
      const config = loadConfig(env);
      assert.deepEqual(
        [...config.allowedOrigins],
        ['https://a.example.com', 'https://b.example.com'],
      );
    });

    it('rejects an origins value that contains only separators', () => {
      const env = validEnv();
      env.ALLOWED_ORIGINS = ' , , ';
      assert.throws(() => loadConfig(env), ConfigError);
    });
  });

  describe('missing required vars', () => {
    const required = [
      'NODE_ENV',
      'PORT',
      'PUBLIC_HOST',
      'ALLOWED_ORIGINS',
      'DATABASE_URL',
      'REDIS_URL',
      'API_KEY_HMAC_SECRET',
    ] as const;

    for (const name of required) {
      it(`throws ConfigError when ${name} is missing`, () => {
        const env = validEnv();
        delete env[name];
        assert.throws(
          () => loadConfig(env),
          (err: unknown) => {
            assert.ok(err instanceof ConfigError);
            assert.ok(isAppError(err));
            assert.match(err.message, new RegExp(name));
            return true;
          },
        );
      });

      it(`throws ConfigError when ${name} is empty`, () => {
        const env = validEnv();
        env[name] = '';
        assert.throws(
          () => loadConfig(env),
          (err: unknown) => err instanceof ConfigError,
        );
      });
    }
  });

  describe('invalid types', () => {
    it('rejects a NODE_ENV outside the literal union', () => {
      const env = validEnv();
      env.NODE_ENV = 'staging';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a non-numeric PORT', () => {
      const env = validEnv();
      env.PORT = 'not-a-number';
      assert.throws(
        () => loadConfig(env),
        (err: unknown) => err instanceof ConfigError && /PORT/.test((err as Error).message),
      );
    });

    it('rejects a PORT outside the valid range', () => {
      const env = validEnv();
      env.PORT = '70000';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a non-integer PORT', () => {
      const env = validEnv();
      env.PORT = '3000.5';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects an invalid LOG_LEVEL value', () => {
      const env = validEnv();
      env.LOG_LEVEL = 'verbose';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a DATABASE_POOL_MAX less than 1', () => {
      const env = validEnv();
      env.DATABASE_POOL_MAX = '0';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a SHUTDOWN_TIMEOUT_MS below the 1000ms floor', () => {
      const env = validEnv();
      env.SHUTDOWN_TIMEOUT_MS = '500';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects an invalid SEARXNG_URL', () => {
      const env = validEnv();
      env.SEARXNG_URL = 'not-a-url';
      assert.throws(() => loadConfig(env), ConfigError);
    });
  });

  describe('API_KEY_HMAC_SECRET validation', () => {
    it('rejects a secret shorter than 32 decoded bytes', () => {
      const env = validEnv();
      env.API_KEY_HMAC_SECRET = 'dGlueQ=='; // decodes to 4 bytes
      assert.throws(
        () => loadConfig(env),
        (err: unknown) =>
          err instanceof ConfigError && /API_KEY_HMAC_SECRET/.test((err as Error).message),
      );
    });

    it('rejects non-base64 junk', () => {
      const env = validEnv();
      env.API_KEY_HMAC_SECRET = 'not valid base64!!';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('accepts a base64url secret of sufficient length', () => {
      const env = validEnv();
      env.API_KEY_HMAC_SECRET = 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw';
      assert.equal(loadConfig(env).apiKeyHmacSecret.length, 46);
    });

    it('rejects the .env.example placeholder value', () => {
      const env = validEnv();
      env.API_KEY_HMAC_SECRET = 'replace-me-with-32-random-bytes-base64';
      assert.throws(() => loadConfig(env), ConfigError);
    });
  });

  describe('frozen result', () => {
    it('prevents mutation of the returned config', () => {
      const config = loadConfig(validEnv());
      assert.throws(() => {
        (config as { port: number }).port = 1;
      }, TypeError);
    });

    it('prevents mutation of allowedOrigins', () => {
      const config = loadConfig(validEnv());
      assert.throws(() => {
        (config.allowedOrigins as string[]).push('https://evil.example.com');
      }, TypeError);
    });
  });
});
