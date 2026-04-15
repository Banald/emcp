import { Readable, Writable } from 'node:stream';
import { mock } from 'node:test';
import type { Logger } from 'pino';
import type { CliDeps } from '../../src/cli/common.ts';
import type {
  ApiKeyRecord,
  ApiKeyRepository,
  CreateApiKeyInput,
} from '../../src/db/repos/api-keys.ts';

export interface CapturedLog {
  level: string;
  fields: Record<string, unknown>;
  message: string | undefined;
}

export interface CapturedDeps {
  deps: CliDeps;
  stdoutText(): string;
  stderrText(): string;
  logs: CapturedLog[];
}

export function makeCapturedDeps(opts: {
  repo: Partial<ApiKeyRepository>;
  stdin?: string;
}): CapturedDeps {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb): void {
      stdoutChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb): void {
      stderrChunks.push(Buffer.from(chunk));
      cb();
    },
  });
  const stdin = Readable.from(opts.stdin ?? '');
  const logs: CapturedLog[] = [];
  const capture =
    (level: string) =>
    (first: Record<string, unknown> | string, second?: string): void => {
      if (typeof first === 'string') {
        logs.push({ level, fields: {}, message: first });
      } else {
        logs.push({ level, fields: first, message: second });
      }
    };
  const loggerMock = {
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
    fatal: capture('fatal'),
    trace: capture('trace'),
  } as unknown as Logger;
  (loggerMock as unknown as { child: () => Logger }).child = (): Logger => loggerMock;
  const deps: CliDeps = {
    repo: opts.repo as ApiKeyRepository,
    stdin,
    stdout,
    stderr,
    logger: loggerMock,
  };
  return {
    deps,
    stdoutText: () => Buffer.concat(stdoutChunks).toString('utf8'),
    stderrText: () => Buffer.concat(stderrChunks).toString('utf8'),
    logs,
  };
}

// Pre-typed mock factories. Providing an implementation matching the signature is what lets
// TypeScript infer the right Mock<F> and therefore the correct `.mock.calls[i].arguments` tuple.
export const mockCreate = (
  impl?: (input: CreateApiKeyInput) => Promise<ApiKeyRecord>,
): ReturnType<typeof mock.fn<(input: CreateApiKeyInput) => Promise<ApiKeyRecord>>> =>
  mock.fn<(input: CreateApiKeyInput) => Promise<ApiKeyRecord>>(impl ?? (async () => makeRecord()));

export const mockVoidById = (): ReturnType<typeof mock.fn<(id: string) => Promise<void>>> =>
  mock.fn<(id: string) => Promise<void>>(async () => undefined);

export const mockSetRateLimit = (): ReturnType<
  typeof mock.fn<(id: string, perMinute: number) => Promise<void>>
> =>
  mock.fn<(id: string, perMinute: number) => Promise<void>>(
    async (_id: string, _n: number) => undefined,
  );

export const mockFindById = (
  result: ApiKeyRecord | null,
): ReturnType<typeof mock.fn<(id: string) => Promise<ApiKeyRecord | null>>> =>
  mock.fn<(id: string) => Promise<ApiKeyRecord | null>>(async () => result);

export const mockFindByPrefix = (
  result: ApiKeyRecord | null,
): ReturnType<typeof mock.fn<(prefix: string) => Promise<ApiKeyRecord | null>>> =>
  mock.fn<(prefix: string) => Promise<ApiKeyRecord | null>>(async () => result);

export const mockList = (
  result: ApiKeyRecord[] = [],
): ReturnType<typeof mock.fn<(filter?: unknown) => Promise<ApiKeyRecord[]>>> =>
  mock.fn<(filter?: unknown) => Promise<ApiKeyRecord[]>>(async () => result);

export function makeRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: '7c4f8b1d-0000-4000-8000-000000000000',
    keyPrefix: 'mcp_live_abc',
    keyHash: 'a'.repeat(64),
    name: 'Test Key',
    status: 'active',
    rateLimitPerMinute: 60,
    allowNoOrigin: false,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    lastUsedAt: null,
    blacklistedAt: null,
    deletedAt: null,
    requestCount: 0n,
    bytesIn: 0n,
    bytesOut: 0n,
    totalComputeMs: 0n,
    ...overrides,
  };
}
