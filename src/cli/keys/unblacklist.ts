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

const USAGE = 'usage: keys unblacklist <id-or-prefix> [--yes]';

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

  const result = await findKey(deps.repo, target);
  if (!result.ok) {
    writeLine(deps.stderr, result.message);
    return result.reason === 'not-found' ? EXIT_NOT_FOUND : EXIT_VALIDATION;
  }
  const record = result.record;

  if (record.status !== 'blacklisted') {
    writeLine(deps.stderr, `error: key ${record.keyPrefix} is ${record.status}, not blacklisted`);
    return EXIT_VALIDATION;
  }

  if (parsed.values.yes !== true) {
    const ok = await confirm(deps, `Unblacklist key ${record.keyPrefix} (${record.name})? [y/N] `);
    if (!ok) {
      writeLine(deps.stdout, 'aborted');
      return EXIT_OK;
    }
  }

  await deps.repo.unblacklist(record.id);
  writeLine(deps.stdout, `unblacklisted ${record.keyPrefix} (${record.name})`);

  audit(deps.auditLogger, 'api_key.unblacklisted', 'api key unblacklisted', {
    keyId: record.id,
    keyPrefix: record.keyPrefix,
  });

  return EXIT_OK;
};
