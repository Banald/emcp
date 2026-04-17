import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it, mock } from 'node:test';
import type { Logger } from 'pino';
import { createChildLogger, createLogger, fatalAndExit, logger, REDACT_PATHS } from './logger.ts';

function captureLogger(level = 'trace') {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const log = createLogger({ level, destination });
  return {
    log,
    entries(): Array<Record<string, unknown>> {
      return chunks
        .flatMap((c) => c.split('\n'))
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
  };
}

describe('logger redaction', () => {
  it('redacts every documented SECURITY Rule 5 path', () => {
    assert.deepEqual(
      [...REDACT_PATHS],
      [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        '*.apiKey',
        '*.password',
        '*.secret',
        '*.token',
        '*.hmacSecret',
      ],
    );
  });

  it('redacts req.headers.authorization', () => {
    const { log, entries } = captureLogger();
    log.info({ req: { headers: { authorization: 'Bearer secret', other: 'visible' } } }, 'req');
    const req = entries()[0]?.req as { headers: Record<string, string> };
    assert.equal(req.headers.authorization, '[REDACTED]');
    assert.equal(req.headers.other, 'visible');
  });

  it('redacts req.headers.cookie and req.headers["x-api-key"]', () => {
    const { log, entries } = captureLogger();
    log.info({ req: { headers: { cookie: 'sess=abc', 'x-api-key': 'mcp_live_k7' } } }, 'req');
    const req = entries()[0]?.req as { headers: Record<string, string> };
    assert.equal(req.headers.cookie, '[REDACTED]');
    assert.equal(req.headers['x-api-key'], '[REDACTED]');
  });

  it('redacts wildcard-matched apiKey / password / secret / token / hmacSecret', () => {
    const { log, entries } = captureLogger();
    log.info(
      {
        user: {
          apiKey: 'live-key',
          password: 'pw',
          secret: 'shh',
          token: 'tok',
          hmacSecret: 'pepper',
          safe: 'keep',
        },
      },
      'nested',
    );
    const user = entries()[0]?.user as Record<string, string>;
    assert.equal(user.apiKey, '[REDACTED]');
    assert.equal(user.password, '[REDACTED]');
    assert.equal(user.secret, '[REDACTED]');
    assert.equal(user.token, '[REDACTED]');
    assert.equal(user.hmacSecret, '[REDACTED]');
    assert.equal(user.safe, 'keep');
  });

  it('uses the censor value [REDACTED]', () => {
    const { log, entries } = captureLogger();
    log.info({ scope: { password: 'p' } }, 'x');
    const scope = entries()[0]?.scope as { password: string };
    assert.equal(scope.password, '[REDACTED]');
  });
});

describe('logger level formatting', () => {
  it('emits string level labels, not numeric codes', () => {
    const { log, entries } = captureLogger('debug');
    log.info({ thing: 1 }, 'msg');
    assert.equal(entries()[0]?.level, 'info');
  });

  it('respects the configured level threshold', () => {
    const { log, entries } = captureLogger('warn');
    log.info('should drop');
    log.warn('should emit');
    const levels = entries().map((e) => e.level);
    assert.deepEqual(levels, ['warn']);
  });

  it('honors a silent level', () => {
    const { log, entries } = captureLogger('silent');
    log.info('drop');
    log.error('also drop');
    assert.equal(entries().length, 0);
  });
});

describe('child loggers', () => {
  it('inherit redaction from the root singleton', () => {
    const chunks: string[] = [];
    const capture = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(chunk.toString('utf8'));
        cb();
      },
    });
    const root = createLogger({ level: 'info', destination: capture });
    const child = root.child({ requestId: 'req-1' });
    child.info({ user: { apiKey: 'secret' } }, 'child log');
    const entry = JSON.parse(chunks.join('').trim().split('\n').pop() ?? '{}') as {
      requestId: string;
      user: { apiKey: string };
    };
    assert.equal(entry.requestId, 'req-1');
    assert.equal(entry.user.apiKey, '[REDACTED]');
  });

  it('createChildLogger binds context to the exported logger singleton', () => {
    const child = createChildLogger({ requestId: 'abc' });
    assert.equal(typeof child.info, 'function');
    assert.equal(typeof child.child, 'function');
  });
});

describe('default logger singleton', () => {
  it('is exported and exposes the pino API', () => {
    assert.equal(typeof logger.info, 'function');
    assert.equal(typeof logger.error, 'function');
    assert.equal(typeof logger.child, 'function');
  });

  it('uses silent level in the test environment', () => {
    assert.equal(logger.level, 'silent');
  });
});

describe('fatalAndExit', () => {
  function makeFakeLogger(): {
    logger: Logger;
    fatalCalls: Array<[Record<string, unknown>, string]>;
    flushWasCalled: () => boolean;
  } {
    const fatalCalls: Array<[Record<string, unknown>, string]> = [];
    let flushCalled = false;
    const fake = {
      fatal: (bindings: Record<string, unknown>, message: string) => {
        fatalCalls.push([bindings, message]);
      },
      flush: (cb: () => void) => {
        flushCalled = true;
        cb();
      },
    } as unknown as Logger;
    return { logger: fake, fatalCalls, flushWasCalled: () => flushCalled };
  }

  it('logs a fatal record, flushes the logger, then exits with the given code', async () => {
    const fake = makeFakeLogger();
    const exit = mock.fn<(code: number) => never>(
      ((_code: number) => undefined as never) as (code: number) => never,
    );
    await fatalAndExit(new Error('boom'), 'startup failed', 17, fake.logger, exit);
    assert.equal(fake.fatalCalls.length, 1);
    const [bindings, message] = fake.fatalCalls[0];
    assert.ok(bindings.err instanceof Error);
    assert.equal(message, 'startup failed');
    assert.equal(fake.flushWasCalled(), true);
    assert.equal(exit.mock.callCount(), 1);
    assert.equal(exit.mock.calls[0].arguments[0], 17);
  });

  it('defaults exit code to 1', async () => {
    const fake = makeFakeLogger();
    let received: number | undefined;
    await fatalAndExit('reason', 'msg', undefined, fake.logger, ((code: number): never => {
      received = code;
      return undefined as never;
    }) as (code: number) => never);
    assert.equal(received, 1);
  });

  it('awaits flush before exiting', async () => {
    const fatalCalls: Array<[Record<string, unknown>, string]> = [];
    let flushResolve: (() => void) | undefined;
    const fake = {
      fatal: (b: Record<string, unknown>, m: string) => fatalCalls.push([b, m]),
      flush: (cb: () => void) => {
        flushResolve = cb;
      },
    } as unknown as Logger;
    let exited = false;
    const exitFn = ((_code: number): never => {
      exited = true;
      return undefined as never;
    }) as (code: number) => never;
    const pending = fatalAndExit(new Error('x'), 'pending', 1, fake, exitFn);
    // Give the microtask queue a chance — flush hasn't fired, so exit hasn't happened.
    await new Promise((r) => setImmediate(r));
    assert.equal(exited, false);
    flushResolve?.();
    await pending;
    assert.equal(exited, true);
  });
});
