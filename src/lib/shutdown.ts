import type { Logger } from 'pino';
import { config } from '../config.ts';
import { logger } from './logger.ts';

interface Entry {
  name: string;
  handler: () => Promise<void>;
}

export interface ShutdownRegistryOptions {
  totalTimeoutMs?: number;
  minHandlerTimeoutMs?: number;
  logger?: Logger;
}

export class ShutdownRegistry {
  private readonly entries: Entry[] = [];
  private started: Promise<void> | null = null;
  private readonly totalTimeoutMs: number;
  private readonly minHandlerTimeoutMs: number;
  private readonly log: Logger;

  constructor(opts: ShutdownRegistryOptions = {}) {
    this.totalTimeoutMs = opts.totalTimeoutMs ?? config.shutdownTimeoutMs;
    this.minHandlerTimeoutMs = opts.minHandlerTimeoutMs ?? 5000;
    this.log = opts.logger ?? logger;
  }

  register(name: string, handler: () => Promise<void>): void {
    this.entries.push({ name, handler });
  }

  get size(): number {
    return this.entries.length;
  }

  get isStarted(): boolean {
    return this.started !== null;
  }

  run(reason: string): Promise<void> {
    if (this.started !== null) return this.started;
    this.started = this.execute(reason);
    return this.started;
  }

  perHandlerTimeoutMs(): number {
    if (this.entries.length === 0) return this.minHandlerTimeoutMs;
    const share = Math.floor(this.totalTimeoutMs / this.entries.length);
    return Math.max(share, this.minHandlerTimeoutMs);
  }

  private async execute(reason: string): Promise<void> {
    const count = this.entries.length;
    this.log.info({ reason, handlers: count }, 'shutdown initiated');
    if (count === 0) {
      this.log.info('shutdown complete');
      return;
    }
    const timeoutMs = this.perHandlerTimeoutMs();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry === undefined) continue;
      await this.runOne(entry, timeoutMs);
    }
    this.log.info('shutdown complete');
  }

  private async runOne(entry: Entry, timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        entry.handler(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error(`shutdown handler "${entry.name}" timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      this.log.error({ err, name: entry.name }, 'shutdown handler failed');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

const defaultRegistry = new ShutdownRegistry();

export function registerShutdown(name: string, handler: () => Promise<void>): void {
  defaultRegistry.register(name, handler);
}

export function runShutdown(reason: string): Promise<void> {
  return defaultRegistry.run(reason);
}

export type ExitFn = (code: number) => void;

const realExit: ExitFn = (code) => {
  process.exit(code);
};

export type ShutdownRunner = (reason: string) => Promise<void>;

export async function handleSignal(
  signal: 'SIGTERM' | 'SIGINT',
  exit: ExitFn = realExit,
  runner: ShutdownRunner = runShutdown,
): Promise<void> {
  try {
    await runner(`signal:${signal}`);
    exit(0);
  } catch (err) {
    logger.error({ err, signal }, 'shutdown rejected');
    exit(1);
  }
}

export function installSignalHandlers(): void {
  process.once('SIGTERM', () => {
    void handleSignal('SIGTERM');
  });
  process.once('SIGINT', () => {
    void handleSignal('SIGINT');
  });
}

installSignalHandlers();
