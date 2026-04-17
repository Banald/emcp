import type { Bindings, DestinationStream, Logger, LoggerOptions } from 'pino';
import { pino, transport as pinoTransport } from 'pino';
import { config } from '../config.ts';

export const REDACT_PATHS: readonly string[] = Object.freeze([
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  '*.apiKey',
  '*.password',
  '*.secret',
  '*.token',
  '*.hmacSecret',
]);

function buildOptions(level: string): LoggerOptions {
  return {
    level,
    redact: {
      paths: [...REDACT_PATHS],
      censor: '[REDACTED]',
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
  };
}

function defaultDestination(): DestinationStream | undefined {
  if (config.nodeEnv === 'development') {
    return pinoTransport({
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
    }) as DestinationStream;
  }
  return undefined;
}

function defaultLevel(): string {
  return config.nodeEnv === 'test' ? 'silent' : config.logLevel;
}

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = options.level ?? defaultLevel();
  const destination = options.destination ?? defaultDestination();
  return destination ? pino(buildOptions(level), destination) : pino(buildOptions(level));
}

export const logger: Logger = createLogger();

export function createChildLogger(bindings: Bindings): Logger {
  return logger.child(bindings);
}

export type ExitFn = (code: number) => never;

/**
 * Log a fatal record and exit the process after pino has flushed.
 * Replaces the historical `setTimeout(process.exit, 100)` flush hack:
 * that timer was a guess that could drop the fatal line on a slow
 * transport and added unneeded delay on a fast one. `logger.flush(cb)`
 * is a no-op on the default synchronous stdout path and waits for
 * drain on a transport-backed logger — fatal lines are always delivered.
 *
 * `targetLogger` and `exit` are dependency-injected so the function is
 * unit-testable without actually calling `process.exit`.
 */
export async function fatalAndExit(
  err: unknown,
  message: string,
  code = 1,
  targetLogger: Logger = logger,
  exit: ExitFn = process.exit as ExitFn,
): Promise<never> {
  targetLogger.fatal({ err }, message);
  await new Promise<void>((resolve) => targetLogger.flush(() => resolve()));
  return exit(code);
}
