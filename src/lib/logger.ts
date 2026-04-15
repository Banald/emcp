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
