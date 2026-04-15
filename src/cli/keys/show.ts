import { parseArgs } from 'node:util';
import {
  type CliDeps,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_VALIDATION,
  findKey,
  type SubcommandRun,
  safeParse,
  writeLine,
} from '../common.ts';

const USAGE = 'usage: keys show <id-or-prefix>';

export const run: SubcommandRun = async (args, deps: CliDeps) => {
  const parsed = safeParse(
    () => parseArgs({ args, options: {}, strict: true, allowPositionals: true }),
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

  writeLine(deps.stdout, `ID:             ${record.id}`);
  writeLine(deps.stdout, `Prefix:         ${record.keyPrefix}`);
  writeLine(deps.stdout, `Name:           ${record.name}`);
  writeLine(deps.stdout, `Status:         ${record.status}`);
  writeLine(deps.stdout, `Rate limit:     ${record.rateLimitPerMinute} / min`);
  writeLine(deps.stdout, `Allow no origin: ${record.allowNoOrigin}`);
  writeLine(deps.stdout, `Created:        ${record.createdAt.toISOString()}`);
  writeLine(
    deps.stdout,
    `Last used:      ${record.lastUsedAt ? record.lastUsedAt.toISOString() : '(never)'}`,
  );
  writeLine(
    deps.stdout,
    `Blacklisted:    ${record.blacklistedAt ? record.blacklistedAt.toISOString() : '(no)'}`,
  );
  writeLine(
    deps.stdout,
    `Deleted:        ${record.deletedAt ? record.deletedAt.toISOString() : '(no)'}`,
  );
  writeLine(deps.stdout, '');
  writeLine(deps.stdout, `Requests:       ${record.requestCount}`);
  writeLine(deps.stdout, `Bytes in:       ${record.bytesIn}`);
  writeLine(deps.stdout, `Bytes out:      ${record.bytesOut}`);
  writeLine(deps.stdout, `Compute ms:     ${record.totalComputeMs}`);

  return EXIT_OK;
};
