import { parseArgs } from 'node:util';
import {
  audit,
  type CliDeps,
  confirm,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_VALIDATION,
  findKey,
  type SubcommandRun,
  safeParse,
  writeLine,
} from '../common.ts';

const OPTIONS = {
  yes: { type: 'boolean', short: 'y' },
  reason: { type: 'string' },
} as const;

const USAGE = 'usage: keys blacklist <id-or-prefix> [--reason <reason>] [--yes]';

export const run: SubcommandRun = async (args, deps: CliDeps) => {
  const parsed = safeParse(
    () => parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: true }),
    deps,
    USAGE,
  );
  if (parsed === null) return EXIT_VALIDATION;

  const target = parsed.positionals[0];
  if (!target) {
    writeLine(deps.stderr, 'error: missing positional <id-or-prefix>');
    return EXIT_VALIDATION;
  }

  const record = await findKey(deps.repo, target);
  if (record === null) {
    writeLine(deps.stderr, `not found: ${target}`);
    return EXIT_NOT_FOUND;
  }

  if (parsed.values.yes !== true) {
    const ok = await confirm(deps, `Blacklist key ${record.keyPrefix} (${record.name})? [y/N] `);
    if (!ok) {
      writeLine(deps.stdout, 'aborted');
      return EXIT_OK;
    }
  }

  await deps.repo.blacklist(record.id);
  writeLine(deps.stdout, `blacklisted ${record.keyPrefix} (${record.name})`);

  audit(deps.logger, 'api_key.blacklisted', 'api key blacklisted', {
    keyId: record.id,
    keyPrefix: record.keyPrefix,
    reason: parsed.values.reason,
  });

  return EXIT_OK;
};
