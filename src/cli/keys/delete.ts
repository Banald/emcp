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
} as const;

const USAGE = 'usage: keys delete <id-or-prefix> [--yes]';

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
    writeLine(deps.stdout, '!!! DELETE IS PERMANENT — THIS KEY WILL NEVER BE REACTIVATABLE !!!');
    writeLine(deps.stdout, `Key: ${record.keyPrefix} (${record.name})`);
    const ok = await confirm(deps, 'Type "yes" to confirm deletion: ');
    if (!ok) {
      writeLine(deps.stdout, 'aborted');
      return EXIT_OK;
    }
  }

  await deps.repo.softDelete(record.id);
  writeLine(deps.stdout, `deleted ${record.keyPrefix} (${record.name})`);

  audit(deps.auditLogger, 'api_key.deleted', 'api key soft-deleted', {
    keyId: record.id,
    keyPrefix: record.keyPrefix,
  });

  return EXIT_OK;
};
