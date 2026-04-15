import { parseArgs } from 'node:util';
import type { ApiKeyRecord } from '../../db/repos/api-keys.ts';
import {
  type CliDeps,
  EXIT_OK,
  EXIT_VALIDATION,
  type SubcommandRun,
  safeParse,
  writeLine,
} from '../common.ts';

const OPTIONS = {
  status: { type: 'string' },
} as const;

const USAGE = 'usage: keys list [--status active|blacklisted|deleted|all]';

const VALID_STATUS = new Set(['active', 'blacklisted', 'deleted', 'all']);

export const run: SubcommandRun = async (args, deps: CliDeps) => {
  const parsed = safeParse(
    () => parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }),
    deps,
    USAGE,
  );
  if (parsed === null) return EXIT_VALIDATION;

  const status = parsed.values.status;
  if (status !== undefined && !VALID_STATUS.has(status)) {
    writeLine(deps.stderr, `error: --status must be one of active, blacklisted, deleted, all`);
    return EXIT_VALIDATION;
  }

  const rows = await deps.repo.list(
    status === undefined ? {} : { status: status as 'active' | 'blacklisted' | 'deleted' | 'all' },
  );

  if (rows.length === 0) {
    writeLine(deps.stdout, '(no keys)');
    return EXIT_OK;
  }

  writeLine(deps.stdout, formatTable(rows));
  return EXIT_OK;
};

function formatTable(rows: readonly ApiKeyRecord[]): string {
  const headers = ['ID', 'PREFIX', 'NAME', 'STATUS', 'CREATED'];
  const body = rows.map((r) => [r.id, r.keyPrefix, r.name, r.status, r.createdAt.toISOString()]);
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...body.map((row) => (row[i] ?? '').length)),
  );
  const format = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? cell.length)).join('  ');
  return [format(headers), ...body.map(format)].join('\n');
}
