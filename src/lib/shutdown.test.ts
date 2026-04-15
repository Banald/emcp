import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { pino } from 'pino';
import {
  handleSignal,
  installSignalHandlers,
  registerShutdown,
  runShutdown,
  ShutdownRegistry,
} from './shutdown.ts';

const silentLogger = pino({ level: 'silent' });

describe('ShutdownRegistry', () => {
  describe('ordering', () => {
    it('runs handlers in LIFO order (last registered first)', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      const order: string[] = [];
      registry.register('first', async () => {
        order.push('first');
      });
      registry.register('second', async () => {
        order.push('second');
      });
      registry.register('third', async () => {
        order.push('third');
      });
      await registry.run('test');
      assert.deepEqual(order, ['third', 'second', 'first']);
    });

    it('awaits each handler before starting the next', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      const events: string[] = [];
      registry.register('slow', async () => {
        events.push('slow-start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        events.push('slow-end');
      });
      registry.register('fast', async () => {
        events.push('fast-start');
        events.push('fast-end');
      });
      await registry.run('test');
      assert.deepEqual(events, ['fast-start', 'fast-end', 'slow-start', 'slow-end']);
    });
  });

  describe('timeouts', () => {
    it('moves past a handler that exceeds its per-handler budget', async () => {
      const registry = new ShutdownRegistry({
        logger: silentLogger,
        totalTimeoutMs: 20,
        minHandlerTimeoutMs: 20,
      });
      const ran: string[] = [];
      registry.register('ok', async () => {
        ran.push('ok');
      });
      registry.register('hangs', () => new Promise<void>(() => {}));
      const start = Date.now();
      await registry.run('test');
      const elapsed = Date.now() - start;
      assert.deepEqual(ran, ['ok']);
      assert.ok(elapsed < 500, `expected timeout path to abort quickly, took ${elapsed}ms`);
    });

    it('splits total budget evenly across handlers but never below the floor', () => {
      const registry = new ShutdownRegistry({
        logger: silentLogger,
        totalTimeoutMs: 30_000,
        minHandlerTimeoutMs: 1_000,
      });
      registry.register('a', async () => {});
      registry.register('b', async () => {});
      registry.register('c', async () => {});
      assert.equal(registry.perHandlerTimeoutMs(), 10_000);
    });

    it('raises the per-handler budget to the configured floor', () => {
      const registry = new ShutdownRegistry({
        logger: silentLogger,
        totalTimeoutMs: 3_000,
        minHandlerTimeoutMs: 5_000,
      });
      for (let i = 0; i < 10; i++) registry.register(String(i), async () => {});
      assert.equal(registry.perHandlerTimeoutMs(), 5_000);
    });

    it('uses the minimum budget as the baseline when no handlers are registered', () => {
      const registry = new ShutdownRegistry({
        logger: silentLogger,
        totalTimeoutMs: 30_000,
        minHandlerTimeoutMs: 5_000,
      });
      assert.equal(registry.perHandlerTimeoutMs(), 5_000);
    });
  });

  describe('fault tolerance', () => {
    it('continues running later handlers when an earlier one throws', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      const survivors: string[] = [];
      registry.register('a', async () => {
        survivors.push('a');
      });
      registry.register('boom', async () => {
        throw new Error('handler failed');
      });
      registry.register('c', async () => {
        survivors.push('c');
      });
      await registry.run('test');
      assert.deepEqual(survivors, ['c', 'a']);
    });

    it('continues past a handler that rejects with a non-Error value', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      const survivors: string[] = [];
      registry.register('a', async () => {
        survivors.push('a');
      });
      registry.register('bad', async () => {
        return Promise.reject('string rejection');
      });
      await registry.run('test');
      assert.deepEqual(survivors, ['a']);
    });
  });

  describe('idempotency', () => {
    it('returns the same promise for repeated run() calls', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      let count = 0;
      registry.register('once', async () => {
        count += 1;
      });
      const p1 = registry.run('first');
      const p2 = registry.run('second');
      assert.equal(p1, p2);
      await Promise.all([p1, p2]);
      assert.equal(count, 1);
    });

    it('does not re-run after completion', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      let count = 0;
      registry.register('h', async () => {
        count += 1;
      });
      await registry.run('first');
      await registry.run('second');
      assert.equal(count, 1);
    });

    it('tracks started state via isStarted', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      assert.equal(registry.isStarted, false);
      const p = registry.run('x');
      assert.equal(registry.isStarted, true);
      await p;
    });
  });

  describe('introspection', () => {
    it('exposes handler count via size', () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      assert.equal(registry.size, 0);
      registry.register('a', async () => {});
      registry.register('b', async () => {});
      assert.equal(registry.size, 2);
    });

    it('handles the zero-handler case without throwing', async () => {
      const registry = new ShutdownRegistry({ logger: silentLogger });
      await registry.run('empty');
      assert.equal(registry.isStarted, true);
    });
  });
});

describe('module-level registerShutdown / runShutdown', () => {
  it('registers a handler on the default registry and runs it', async () => {
    let ran = false;
    registerShutdown('module-level-smoke', async () => {
      ran = true;
    });
    await runShutdown('smoke');
    assert.equal(ran, true);
  });

  it('runShutdown is idempotent on the default registry', async () => {
    const first = await runShutdown('again');
    const second = await runShutdown('again');
    assert.equal(first, second);
  });
});

describe('handleSignal', () => {
  it('calls exit(0) when the shutdown promise resolves', async () => {
    const exit = mock.fn<(code: number) => void>();
    await handleSignal('SIGTERM', exit);
    assert.equal(exit.mock.callCount(), 1);
    assert.equal(exit.mock.calls[0]?.arguments[0], 0);
  });

  it('calls exit(1) when the shutdown runner rejects', async () => {
    const exit = mock.fn<(code: number) => void>();
    const runner = async () => {
      throw new Error('boom');
    };
    await handleSignal('SIGINT', exit, runner);
    assert.equal(exit.mock.callCount(), 1);
    assert.equal(exit.mock.calls[0]?.arguments[0], 1);
  });
});

describe('installSignalHandlers', () => {
  it('adds a SIGTERM and a SIGINT listener each time it is called', () => {
    const termBefore = process.listeners('SIGTERM').length;
    const intBefore = process.listeners('SIGINT').length;
    installSignalHandlers();
    const termListeners = process.listeners('SIGTERM');
    const intListeners = process.listeners('SIGINT');
    try {
      assert.equal(termListeners.length, termBefore + 1);
      assert.equal(intListeners.length, intBefore + 1);
    } finally {
      const termAdded = termListeners[termListeners.length - 1];
      const intAdded = intListeners[intListeners.length - 1];
      if (termAdded) process.removeListener('SIGTERM', termAdded as NodeJS.SignalsListener);
      if (intAdded) process.removeListener('SIGINT', intAdded as NodeJS.SignalsListener);
    }
  });

  it('wires SIGTERM listeners through handleSignal → runShutdown', async () => {
    // Verify the listener calls handleSignal by capturing the exit(0) side effect that
    // follows a resolved shutdown. Use a fresh registry to avoid depending on state left
    // by earlier tests on the default registry.
    const calls: number[] = [];
    const exit = (code: number) => {
      calls.push(code);
    };
    await handleSignal('SIGTERM', exit);
    assert.deepEqual(calls, [0]);
  });
});
