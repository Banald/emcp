import { parseArgs } from 'node:util';
import {
  audit,
  type CliDeps,
  EXIT_NOT_FOUND,
  EXIT_OK,
  EXIT_VALIDATION,
  findKey,
  type SubcommandRun,
  safeParse,
  writeLine,
} from '../common.ts';

const USAGE = 'usage: keys set-rate-limit <id-or-prefix> <per-minute>';

export const run: SubcommandRun = async (args, deps: CliDeps) => {
  const parsed = safeParse(
    () => parseArgs({ args, options: {}, strict: true, allowPositionals: true }),
    deps,
    USAGE,
  );
  if (parsed === null) return EXIT_VALIDATION;

  const [target, rawLimit] = parsed.positionals;
  if (!target || !rawLimit) {
    writeLine(deps.stderr, USAGE);
    return EXIT_VALIDATION;
  }

  const perMinute = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(perMinute) || perMinute < 1 || String(perMinute) !== rawLimit) {
    writeLine(deps.stderr, 'error: <per-minute> must be a positive integer');
    return EXIT_VALIDATION;
  }

  const result = await findKey(deps.repo, target);
  if (!result.ok) {
    writeLine(deps.stderr, result.message);
    return result.reason === 'not-found' ? EXIT_NOT_FOUND : EXIT_VALIDATION;
  }
  const record = result.record;

  await deps.repo.setRateLimit(record.id, perMinute);
  writeLine(
    deps.stdout,
    `rate limit for ${record.keyPrefix} (${record.name}) set to ${perMinute} / min`,
  );

  audit(deps.auditLogger, 'api_key.rate_limit_changed', 'api key rate limit changed', {
    keyId: record.id,
    keyPrefix: record.keyPrefix,
    previousRateLimitPerMinute: record.rateLimitPerMinute,
    rateLimitPerMinute: perMinute,
  });

  return EXIT_OK;
};
