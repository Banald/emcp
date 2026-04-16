import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { Cron } from 'croner';
import type { Pool } from 'pg';
import { createLogger } from '../lib/logger.ts';
import type { WorkerContext } from '../shared/workers/types.ts';
import worker from './example.ts';

describe('heartbeat worker', () => {
  it('has the expected identity', () => {
    assert.equal(worker.name, 'heartbeat');
    assert.equal(worker.schedule, '*/5 * * * *');
    assert.ok(worker.description);
  });

  it('has a parseable cron schedule', () => {
    const cron = new Cron(worker.schedule, { paused: true });
    cron.stop();
  });

  it('handler resolves without throwing', async () => {
    const info = mock.fn();
    const logger = createLogger({ level: 'silent' }).child({});
    logger.info = info as unknown as typeof logger.info;
    const ctx: WorkerContext = {
      logger,
      db: {} as unknown as Pool,
      signal: new AbortController().signal,
    };
    await worker.handler(ctx);
    assert.equal(info.mock.callCount(), 1);
  });
});
