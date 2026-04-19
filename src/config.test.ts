import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';
import { ConfigError, isAppError } from './lib/errors.ts';

const validEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  EMCP_PORT: '3000',
  EMCP_BIND_HOST: '127.0.0.1',
  EMCP_PUBLIC_HOST: 'mcp.example.com',
  EMCP_ALLOWED_ORIGINS: 'https://a.example.com,https://b.example.com',
  EMCP_DATABASE_URL: 'postgres://u:p@localhost:5432/mcp',
  EMCP_DATABASE_POOL_MAX: '20',
  EMCP_REDIS_URL: 'redis://localhost:6379',
  EMCP_API_KEY_HMAC_SECRET: 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw==',
  EMCP_LOG_LEVEL: 'info',
  EMCP_RATE_LIMIT_DEFAULT_PER_MINUTE: '120',
  EMCP_SHUTDOWN_TIMEOUT_MS: '20000',
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
    it('applies EMCP_BIND_HOST default when unset', () => {
      const env = validEnv();
      delete env.EMCP_BIND_HOST;
      const config = loadConfig(env);
      assert.equal(config.bindHost, '127.0.0.1');
    });

    it('applies EMCP_DATABASE_POOL_MAX / rate limit / shutdown defaults', () => {
      const env = validEnv();
      delete env.EMCP_DATABASE_POOL_MAX;
      delete env.EMCP_RATE_LIMIT_DEFAULT_PER_MINUTE;
      delete env.EMCP_SHUTDOWN_TIMEOUT_MS;
      const config = loadConfig(env);
      assert.equal(config.databasePoolMax, 10);
      assert.equal(config.rateLimitDefaultPerMinute, 60);
      assert.equal(config.shutdownTimeoutMs, 30000);
    });

    it('applies EMCP_MCP_* defaults when unset', () => {
      const config = loadConfig(validEnv());
      assert.equal(config.mcpMaxBodyBytes, 1_048_576);
      assert.equal(config.mcpSessionIdleMs, 30 * 60_000);
      assert.equal(config.mcpSessionCleanupIntervalMs, 60_000);
      assert.equal(config.mcpToolCallTimeoutMs, 30_000);
    });

    it('accepts EMCP_MCP_* overrides within bounds', () => {
      const env = {
        ...validEnv(),
        EMCP_MCP_MAX_BODY_BYTES: '2048',
        EMCP_MCP_SESSION_IDLE_MS: '120000',
        EMCP_MCP_SESSION_CLEANUP_INTERVAL_MS: '5000',
        EMCP_MCP_TOOL_CALL_TIMEOUT_MS: '10000',
      };
      const config = loadConfig(env);
      assert.equal(config.mcpMaxBodyBytes, 2048);
      assert.equal(config.mcpSessionIdleMs, 120000);
      assert.equal(config.mcpSessionCleanupIntervalMs, 5000);
      assert.equal(config.mcpToolCallTimeoutMs, 10000);
    });

    it('rejects EMCP_MCP_* values outside bounds', () => {
      const cases: Array<[string, string]> = [
        ['EMCP_MCP_MAX_BODY_BYTES', '512'], // below 1 KiB minimum
        ['EMCP_MCP_SESSION_IDLE_MS', '1000'], // below 1 min minimum
        ['EMCP_MCP_SESSION_CLEANUP_INTERVAL_MS', '500'], // below 1 s minimum
        ['EMCP_MCP_TOOL_CALL_TIMEOUT_MS', '500'], // below 1 s minimum
      ];
      for (const [key, value] of cases) {
        const env = { ...validEnv(), [key]: value };
        assert.throws(
          () => loadConfig(env),
          (err) => isAppError(err) && err instanceof ConfigError,
          `expected ${key}=${value} to be rejected`,
        );
      }
    });

    it('defaults EMCP_LOG_LEVEL to debug in development', () => {
      const env = validEnv();
      env.NODE_ENV = 'development';
      delete env.EMCP_LOG_LEVEL;
      assert.equal(loadConfig(env).logLevel, 'debug');
    });

    it('defaults EMCP_LOG_LEVEL to info in production', () => {
      const env = validEnv();
      env.NODE_ENV = 'production';
      delete env.EMCP_LOG_LEVEL;
      assert.equal(loadConfig(env).logLevel, 'info');
    });

    it('defaults EMCP_LOG_LEVEL to info in test', () => {
      const env = validEnv();
      env.NODE_ENV = 'test';
      delete env.EMCP_LOG_LEVEL;
      assert.equal(loadConfig(env).logLevel, 'info');
    });

    it('respects an explicit EMCP_LOG_LEVEL override regardless of NODE_ENV', () => {
      const env = validEnv();
      env.NODE_ENV = 'development';
      env.EMCP_LOG_LEVEL = 'warn';
      assert.equal(loadConfig(env).logLevel, 'warn');
    });

    it('applies EMCP_SEARXNG_URL default when unset', () => {
      const env = validEnv();
      delete env.EMCP_SEARXNG_URL;
      const config = loadConfig(env);
      assert.equal(config.searxngUrl, 'http://localhost:8080');
    });

    it('strips trailing slashes from EMCP_SEARXNG_URL', () => {
      const env = validEnv();
      env.EMCP_SEARXNG_URL = 'http://localhost:8080///';
      const config = loadConfig(env);
      assert.equal(config.searxngUrl, 'http://localhost:8080');
    });
  });

  describe('EMCP_ALLOWED_ORIGINS parsing', () => {
    it('splits on comma and trims whitespace', () => {
      const env = validEnv();
      env.EMCP_ALLOWED_ORIGINS =
        '  https://a.example.com , https://b.example.com  ,https://c.example.com';
      const config = loadConfig(env);
      assert.deepEqual(
        [...config.allowedOrigins],
        ['https://a.example.com', 'https://b.example.com', 'https://c.example.com'],
      );
    });

    it('drops empty entries produced by stray commas', () => {
      const env = validEnv();
      env.EMCP_ALLOWED_ORIGINS = 'https://a.example.com,,https://b.example.com,';
      const config = loadConfig(env);
      assert.deepEqual(
        [...config.allowedOrigins],
        ['https://a.example.com', 'https://b.example.com'],
      );
    });

    it('rejects an origins value that contains only separators', () => {
      const env = validEnv();
      env.EMCP_ALLOWED_ORIGINS = ' , , ';
      assert.throws(() => loadConfig(env), ConfigError);
    });
  });

  describe('missing required vars', () => {
    const required = [
      'NODE_ENV',
      'EMCP_PORT',
      'EMCP_PUBLIC_HOST',
      'EMCP_ALLOWED_ORIGINS',
      'EMCP_DATABASE_URL',
      'EMCP_REDIS_URL',
      'EMCP_API_KEY_HMAC_SECRET',
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

    it('rejects a non-numeric EMCP_PORT', () => {
      const env = validEnv();
      env.EMCP_PORT = 'not-a-number';
      assert.throws(
        () => loadConfig(env),
        (err: unknown) => err instanceof ConfigError && /EMCP_PORT/.test((err as Error).message),
      );
    });

    it('rejects an EMCP_PORT outside the valid range', () => {
      const env = validEnv();
      env.EMCP_PORT = '70000';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a non-integer EMCP_PORT', () => {
      const env = validEnv();
      env.EMCP_PORT = '3000.5';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects an invalid EMCP_LOG_LEVEL value', () => {
      const env = validEnv();
      env.EMCP_LOG_LEVEL = 'verbose';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a EMCP_DATABASE_POOL_MAX less than 1', () => {
      const env = validEnv();
      env.EMCP_DATABASE_POOL_MAX = '0';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects a EMCP_SHUTDOWN_TIMEOUT_MS below the 1000ms floor', () => {
      const env = validEnv();
      env.EMCP_SHUTDOWN_TIMEOUT_MS = '500';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects an invalid EMCP_SEARXNG_URL', () => {
      const env = validEnv();
      env.EMCP_SEARXNG_URL = 'not-a-url';
      assert.throws(() => loadConfig(env), ConfigError);
    });
  });

  describe('EMCP_API_KEY_HMAC_SECRET validation', () => {
    it('rejects a secret shorter than 32 decoded bytes', () => {
      const env = validEnv();
      env.EMCP_API_KEY_HMAC_SECRET = 'dGlueQ=='; // decodes to 4 bytes
      assert.throws(
        () => loadConfig(env),
        (err: unknown) =>
          err instanceof ConfigError && /EMCP_API_KEY_HMAC_SECRET/.test((err as Error).message),
      );
    });

    it('rejects non-base64 junk', () => {
      const env = validEnv();
      env.EMCP_API_KEY_HMAC_SECRET = 'not valid base64!!';
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('accepts a base64url secret of sufficient length', () => {
      const env = validEnv();
      env.EMCP_API_KEY_HMAC_SECRET = 'dGVzdC1wZXBwZXItYXQtbGVhc3QtMzItYnl0ZXMtbG9uZw';
      assert.equal(loadConfig(env).apiKeyHmacSecret.length, 46);
    });

    it('rejects the .env.example placeholder value', () => {
      const env = validEnv();
      env.EMCP_API_KEY_HMAC_SECRET = 'replace-me-with-32-random-bytes-base64';
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

  describe('EMCP_PROXY_* egress rotation', () => {
    it('defaults to empty pool + round-robin + standard timings', () => {
      const config = loadConfig(validEnv());
      assert.deepEqual([...config.proxyUrls], []);
      assert.equal(config.proxyRotation, 'round-robin');
      assert.equal(config.proxyFailureCooldownMs, 60_000);
      assert.equal(config.proxyMaxRetriesPerRequest, 3);
      assert.equal(config.proxyConnectTimeoutMs, 10_000);
    });

    it('parses a multi-entry EMCP_PROXY_URLS list', () => {
      const env = {
        ...validEnv(),
        EMCP_PROXY_URLS: 'http://u:p@proxy1.example.com:8080,https://q:r@proxy2.example.com:8443',
      };
      const config = loadConfig(env);
      assert.deepEqual(
        [...config.proxyUrls],
        ['http://u:p@proxy1.example.com:8080', 'https://q:r@proxy2.example.com:8443'],
      );
    });

    it('trims whitespace and drops empty entries in EMCP_PROXY_URLS', () => {
      const env = {
        ...validEnv(),
        EMCP_PROXY_URLS: '  http://h1:80 , , http://h2:81  ',
      };
      const config = loadConfig(env);
      assert.deepEqual([...config.proxyUrls], ['http://h1:80', 'http://h2:81']);
    });

    it('freezes proxyUrls against mutation', () => {
      const env = { ...validEnv(), EMCP_PROXY_URLS: 'http://h1:80' };
      const config = loadConfig(env);
      assert.throws(() => {
        (config.proxyUrls as string[]).push('http://h2:80');
      }, TypeError);
    });

    it('rejects a proxy URL with an unsupported scheme', () => {
      const env = { ...validEnv(), EMCP_PROXY_URLS: 'socks5://proxy.example.com:1080' };
      assert.throws(
        () => loadConfig(env),
        (err: unknown) =>
          err instanceof ConfigError && /http: or https:/.test((err as Error).message),
      );
    });

    it('rejects a proxy URL that is not parseable', () => {
      const env = { ...validEnv(), EMCP_PROXY_URLS: 'not a url' };
      assert.throws(
        () => loadConfig(env),
        (err: unknown) => err instanceof ConfigError && /cannot parse/.test((err as Error).message),
      );
    });

    it('accepts a proxy URL without an explicit port (uses scheme default)', () => {
      // WHATWG URL leaves `.port === ''` for scheme defaults. undici's
      // ProxyAgent handles 80/443 correctly; rejecting would surprise
      // operators who supplied `http://proxy.example.com`.
      const env = { ...validEnv(), EMCP_PROXY_URLS: 'http://proxy.example.com' };
      const config = loadConfig(env);
      assert.deepEqual([...config.proxyUrls], ['http://proxy.example.com']);
    });

    it('rejects a proxy URL with a port out of range (malformed fails parse)', () => {
      // Port > 65535 fails `new URL()` itself; message surfaces as "cannot parse".
      const env = { ...validEnv(), EMCP_PROXY_URLS: 'http://h:99999' };
      assert.throws(
        () => loadConfig(env),
        (err: unknown) => err instanceof ConfigError && /cannot parse/.test((err as Error).message),
      );
    });

    it('never echoes the raw proxy URL in the ConfigError message (no credential leak)', () => {
      // The refinement messages are crafted to describe the defect
      // generically. If a future change accidentally interpolates the
      // URL back into a message, this test will catch the regression.
      const env = {
        ...validEnv(),
        EMCP_PROXY_URLS: 'http://alice:topsecret@h:0',
      };
      try {
        loadConfig(env);
        assert.fail('expected ConfigError');
      } catch (err) {
        assert.ok(err instanceof ConfigError);
        assert.doesNotMatch((err as Error).message, /topsecret/);
        assert.doesNotMatch((err as Error).message, /alice/);
      }
    });

    it('accepts EMCP_PROXY_ROTATION=random', () => {
      const env = { ...validEnv(), EMCP_PROXY_ROTATION: 'random' };
      assert.equal(loadConfig(env).proxyRotation, 'random');
    });

    it('rejects an unknown EMCP_PROXY_ROTATION value', () => {
      const env = { ...validEnv(), EMCP_PROXY_ROTATION: 'weighted' };
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects EMCP_PROXY_FAILURE_COOLDOWN_MS below the 1s floor', () => {
      const env = { ...validEnv(), EMCP_PROXY_FAILURE_COOLDOWN_MS: '500' };
      assert.throws(() => loadConfig(env), ConfigError);
    });

    it('rejects EMCP_PROXY_MAX_RETRIES_PER_REQUEST outside 1..10', () => {
      const over = { ...validEnv(), EMCP_PROXY_MAX_RETRIES_PER_REQUEST: '20' };
      const under = { ...validEnv(), EMCP_PROXY_MAX_RETRIES_PER_REQUEST: '0' };
      assert.throws(() => loadConfig(over), ConfigError);
      assert.throws(() => loadConfig(under), ConfigError);
    });

    it('rejects EMCP_PROXY_CONNECT_TIMEOUT_MS outside 1s..60s', () => {
      const over = { ...validEnv(), EMCP_PROXY_CONNECT_TIMEOUT_MS: '120000' };
      const under = { ...validEnv(), EMCP_PROXY_CONNECT_TIMEOUT_MS: '500' };
      assert.throws(() => loadConfig(over), ConfigError);
      assert.throws(() => loadConfig(under), ConfigError);
    });
  });
});
