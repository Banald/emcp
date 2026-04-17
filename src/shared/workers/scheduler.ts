import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { metrics as realMetrics } from '../../core/metrics.ts';
import type { WorkerContext, WorkerDefinition } from './types.ts';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface CronHandle {
  stop(): void;
}

export type CronFactory = (
  pattern: string,
  opts: { timezone?: string },
  onTick: () => void,
) => CronHandle;

export interface SchedulerMetrics {
  readonly runsTotal: { inc(labels: { worker: string; status: string }): void };
  readonly runDuration: { observe(labels: { worker: string }, value: number): void };
}

export interface SchedulerDeps {
  readonly workers: readonly WorkerDefinition[];
  readonly db: Pool;
  readonly logger: Logger;
  readonly shutdownSignal: AbortSignal;
  readonly cronFactory?: CronFactory;
  readonly metrics?: SchedulerMetrics;
}

export interface Scheduler {
  start(): Promise<void>;
  stop(graceTimeoutMs: number): Promise<void>;
}

const defaultCronFactory: CronFactory = (pattern, opts, onTick) => {
  const cron = new Cron(pattern, { timezone: opts.timezone }, onTick);
  return { stop: () => cron.stop() };
};

interface WorkerState {
  def: WorkerDefinition;
  cronHandle: CronHandle;
  inFlight: boolean;
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const cronFactory = deps.cronFactory ?? defaultCronFactory;
  const schedulerMetrics: SchedulerMetrics = deps.metrics ?? {
    runsTotal: realMetrics.workerRunsTotal,
    runDuration: realMetrics.workerRunDuration,
  };
  const states: WorkerState[] = [];
  let stopped = false;

  const runOnce = async (state: WorkerState): Promise<void> => {
    if (stopped) return;
    const { def } = state;
    if (state.inFlight) {
      deps.logger.info({ worker: def.name }, 'worker_fire_skipped');
      schedulerMetrics.runsTotal.inc({ worker: def.name, status: 'skipped_overlap' });
      return;
    }
    state.inFlight = true;

    const runId = randomUUID();
    const log = deps.logger.child({ worker: def.name, run_id: runId });
    const timeoutMs = def.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const timeoutCtl = new AbortController();
    const signal = AbortSignal.any([deps.shutdownSignal, timeoutCtl.signal]);
    const ctx: WorkerContext = { logger: log, db: deps.db, signal };
    const startedAt = Date.now();

    log.info('worker_run_start');

    let handlerSettled = false;
    let handlerSuccess = false;
    let handlerError: unknown;

    const handlerPromise = def.handler(ctx).then(
      () => {
        handlerSettled = true;
        handlerSuccess = true;
      },
      (err: unknown) => {
        handlerSettled = true;
        handlerError = err;
      },
    );

    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutTimer = setTimeout(() => {
        if (!handlerSettled) {
          timeoutCtl.abort(new Error('worker run timed out'));
        }
        resolve();
      }, timeoutMs);
      // Don't let an idle timeout clock keep the event loop alive past shutdown.
      timeoutTimer.unref?.();
    });

    try {
      await Promise.race([handlerPromise, timeoutPromise]);
    } finally {
      if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    }

    const durationMs = Date.now() - startedAt;
    const durationSec = durationMs / 1000;

    if (handlerSettled) {
      if (handlerSuccess) {
        log.info({ duration_ms: durationMs }, 'worker_run_success');
        schedulerMetrics.runsTotal.inc({ worker: def.name, status: 'success' });
      } else {
        log.error({ err: handlerError, duration_ms: durationMs }, 'worker_run_failure');
        schedulerMetrics.runsTotal.inc({ worker: def.name, status: 'failure' });
      }
      schedulerMetrics.runDuration.observe({ worker: def.name }, durationSec);
    } else {
      log.error({ duration_ms: durationMs }, 'worker_run_timeout');
      schedulerMetrics.runsTotal.inc({ worker: def.name, status: 'timeout' });
      schedulerMetrics.runDuration.observe({ worker: def.name }, durationSec);
    }

    state.inFlight = false;
  };

  return {
    async start() {
      for (const def of deps.workers) {
        const state: WorkerState = {
          def,
          inFlight: false,
          cronHandle: { stop: () => {} },
        };
        state.cronHandle = cronFactory(def.schedule, { timezone: def.timezone }, () => {
          void runOnce(state);
        });
        deps.logger.info(
          { worker: def.name, schedule: def.schedule, timezone: def.timezone ?? 'UTC' },
          'worker_scheduled',
        );
        states.push(state);
      }
      for (const state of states) {
        if (state.def.runOnStartup) {
          // Fire-and-forget: a cron scheduler is "ready" when it's ticking,
          // not when the first tick's I/O has finished. Overlap protection
          // (via state.inFlight) prevents the scheduled cron tick from
          // colliding with this startup run; shutdown drains in-flight runs
          // via the shared abort signal.
          void runOnce(state);
        }
      }
    },

    async stop(graceTimeoutMs: number) {
      stopped = true;
      for (const state of states) {
        state.cronHandle.stop();
      }
      const deadline = Date.now() + graceTimeoutMs;
      while (Date.now() < deadline) {
        const anyInFlight = states.some((s) => s.inFlight);
        if (!anyInFlight) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      deps.logger.info(
        { in_flight_remaining: states.filter((s) => s.inFlight).length },
        'worker_stopped',
      );
    },
  };
}
