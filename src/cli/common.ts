import { createInterface } from 'node:readline/promises';
import type { Logger } from 'pino';
import type { ApiKeyRecord, ApiKeyRepository } from '../db/repos/api-keys.ts';
import { ConflictError } from '../lib/errors.ts';

export interface CliDeps {
  repo: ApiKeyRepository;
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  logger: Logger;
  /** Audit-stream logger for key mutations. Production wires this to src/lib/audit.ts; tests mock it. */
  auditLogger: Logger;
}

export type SubcommandRun = (args: string[], deps: CliDeps) => Promise<number>;

// Exit codes per docs/OPERATIONS.md:
// 0 success / 1 not found / 2 validation error / 3 config or connection error
export const EXIT_OK = 0;
export const EXIT_NOT_FOUND = 1;
export const EXIT_VALIDATION = 2;
export const EXIT_CONFIG = 3;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Discriminated result of resolving an `<id-or-prefix>` CLI argument.
 * `reason: 'ambiguous'` surfaces prefix collisions (AUDIT L-4) so the
 * operator can pick the UUID rather than silently mutating the wrong
 * key.
 */
export type FindKeyResult =
  | { ok: true; record: ApiKeyRecord }
  | { ok: false; reason: 'not-found' | 'ambiguous'; message: string };

export async function findKey(repo: ApiKeyRepository, idOrPrefix: string): Promise<FindKeyResult> {
  if (isUuid(idOrPrefix)) {
    const record = await repo.findById(idOrPrefix);
    return record
      ? { ok: true, record }
      : { ok: false, reason: 'not-found', message: `not found: ${idOrPrefix}` };
  }
  try {
    const record = await repo.findByPrefixUnique(idOrPrefix);
    return record
      ? { ok: true, record }
      : { ok: false, reason: 'not-found', message: `not found: ${idOrPrefix}` };
  } catch (err) {
    if (err instanceof ConflictError) {
      return { ok: false, reason: 'ambiguous', message: err.message };
    }
    throw err;
  }
}

export async function confirm(deps: CliDeps, prompt: string): Promise<boolean> {
  const rl = createInterface({ input: deps.stdin, output: deps.stdout, terminal: false });
  try {
    const answer = await rl.question(prompt);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function writeLine(stream: NodeJS.WritableStream, line = ''): void {
  stream.write(`${line}\n`);
}

export interface AuditContext {
  keyId?: string;
  keyPrefix?: string;
  [field: string]: unknown;
}

/**
 * Emits an audit record via the provided logger. Production call sites pass
 * the dedicated audit logger from `src/lib/audit.ts` so mutations land in the
 * audit stream; tests pass a mock logger to inspect the record shape.
 */
export function audit(
  logger: Logger,
  event: string,
  message: string,
  context: AuditContext = {},
): void {
  logger.info({ event, ...context }, message);
}

// Wraps a parseArgs call: writes the error and usage string to stderr on failure, returns null.
// Subcommands use this to avoid declaring a `let parsed` of ambiguous type.
export function safeParse<T>(call: () => T, deps: CliDeps, usage: string): T | null {
  try {
    return call();
  } catch (err) {
    writeLine(deps.stderr, `error: ${(err as Error).message}`);
    writeLine(deps.stderr, usage);
    return null;
  }
}
