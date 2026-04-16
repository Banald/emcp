import { parseArgs } from 'node:util';
import { extractKeyPrefix, generateApiKey, hashApiKey } from '../../core/auth-hash.ts';
import {
  audit,
  type CliDeps,
  EXIT_OK,
  EXIT_VALIDATION,
  type SubcommandRun,
  safeParse,
  writeLine,
} from '../common.ts';

const OPTIONS = {
  name: { type: 'string' },
  'rate-limit': { type: 'string' },
  'allow-no-origin': { type: 'boolean' },
} as const;

const USAGE = 'usage: keys create --name <name> [--rate-limit <n>] [--allow-no-origin]';

export const run: SubcommandRun = async (args, deps: CliDeps) => {
  const parsed = safeParse(
    () => parseArgs({ args, options: OPTIONS, strict: true, allowPositionals: false }),
    deps,
    USAGE,
  );
  if (parsed === null) return EXIT_VALIDATION;

  const name = parsed.values.name?.trim();
  if (!name) {
    writeLine(deps.stderr, 'error: --name is required and must be non-empty');
    return EXIT_VALIDATION;
  }

  let rateLimitPerMinute: number | undefined;
  if (parsed.values['rate-limit'] !== undefined) {
    const n = Number.parseInt(parsed.values['rate-limit'], 10);
    if (!Number.isFinite(n) || n < 1) {
      writeLine(deps.stderr, 'error: --rate-limit must be a positive integer');
      return EXIT_VALIDATION;
    }
    rateLimitPerMinute = n;
  }

  const allowNoOrigin = parsed.values['allow-no-origin'] === true;

  const rawKey = generateApiKey('mcp_live');
  const keyHash = hashApiKey(rawKey);
  const keyPrefix = extractKeyPrefix(rawKey);

  const record = await deps.repo.create({
    keyPrefix,
    keyHash,
    name,
    ...(rateLimitPerMinute === undefined ? {} : { rateLimitPerMinute }),
    allowNoOrigin,
  });

  writeLine(deps.stdout, '⚠️  SAVE THIS KEY NOW — IT WILL NOT BE SHOWN AGAIN ⚠️');
  writeLine(deps.stdout, rawKey);
  writeLine(deps.stdout);
  writeLine(deps.stdout, `ID:     ${record.id}`);
  writeLine(deps.stdout, `Prefix: ${record.keyPrefix}`);
  writeLine(deps.stdout, `Name:   ${record.name}`);

  audit(deps.logger, 'api_key.created', 'api key created', {
    keyId: record.id,
    keyPrefix: record.keyPrefix,
    name: record.name,
    rateLimitPerMinute: record.rateLimitPerMinute,
    allowNoOrigin: record.allowNoOrigin,
  });

  return EXIT_OK;
};
