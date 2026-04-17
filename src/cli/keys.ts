import { parseArgs } from 'node:util';
import { pool } from '../db/client.ts';
import { ApiKeyRepository } from '../db/repos/api-keys.ts';
import { auditLogger } from '../lib/audit.ts';
import { isAppError } from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import type { CliDeps, SubcommandRun } from './common.ts';
import { EXIT_CONFIG, EXIT_VALIDATION, writeLine } from './common.ts';
import { run as runBlacklist } from './keys/blacklist.ts';
import { run as runCreate } from './keys/create.ts';
import { run as runDelete } from './keys/delete.ts';
import { run as runList } from './keys/list.ts';
import { run as runSetRateLimit } from './keys/set-rate-limit.ts';
import { run as runShow } from './keys/show.ts';
import { run as runUnblacklist } from './keys/unblacklist.ts';

export const COMMANDS: Readonly<Record<string, SubcommandRun>> = Object.freeze({
  create: runCreate,
  list: runList,
  show: runShow,
  blacklist: runBlacklist,
  unblacklist: runUnblacklist,
  delete: runDelete,
  'set-rate-limit': runSetRateLimit,
});

const USAGE = [
  'usage: keys <command> [...args]',
  '',
  'commands:',
  '  create --name <name> [--rate-limit <n>] [--allow-no-origin]',
  '  list [--status active|blacklisted|deleted|all]',
  '  show <id-or-prefix>',
  '  blacklist <id-or-prefix> [--reason <reason>] [--yes]',
  '  unblacklist <id-or-prefix> [--yes]',
  '  delete <id-or-prefix> [--yes]',
  '  set-rate-limit <id-or-prefix> <per-minute>',
].join('\n');

export async function dispatchWith(
  commands: Readonly<Record<string, SubcommandRun>>,
  argv: string[],
  deps: CliDeps,
): Promise<number> {
  if (argv.length === 0) {
    writeLine(deps.stderr, USAGE);
    return EXIT_VALIDATION;
  }

  const { positionals } = parseArgs({
    args: argv,
    strict: false,
    allowPositionals: true,
  });
  const commandName = positionals[0];
  if (commandName === undefined) {
    writeLine(deps.stderr, USAGE);
    return EXIT_VALIDATION;
  }

  const command = commands[commandName];
  if (command === undefined) {
    writeLine(deps.stderr, `error: unknown command "${commandName}"`);
    writeLine(deps.stderr, USAGE);
    return EXIT_VALIDATION;
  }

  const args = argv.slice(argv.indexOf(commandName) + 1);
  try {
    return await command(args, deps);
  } catch (err) {
    const message = isAppError(err) ? err.message : (err as Error).message;
    writeLine(deps.stderr, `error: ${message}`);
    deps.logger.error({ err, command: commandName }, 'cli command failed');
    return EXIT_CONFIG;
  }
}

export function dispatch(argv: string[], deps: CliDeps): Promise<number> {
  return dispatchWith(COMMANDS, argv, deps);
}

export interface MainOptions {
  deps?: CliDeps;
  closePool?: () => Promise<void>;
}

export async function main(argv: string[], options: MainOptions = {}): Promise<number> {
  const deps: CliDeps = options.deps ?? {
    repo: new ApiKeyRepository(pool),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    logger,
    auditLogger,
  };
  const close = options.closePool ?? (() => pool.end());
  try {
    return await dispatch(argv, deps);
  } finally {
    await close();
  }
}

/* c8 ignore start — entry-point guard, exercised only when invoked via `node src/cli/keys.ts`. */
if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}
/* c8 ignore stop */
