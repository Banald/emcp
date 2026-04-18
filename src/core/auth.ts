import type { Redis } from 'ioredis';
import type { ApiKeyRepository } from '../db/repos/api-keys.ts';
import {
  type AuthError,
  AuthInvalidCredentialsError,
  AuthMalformedTokenError,
  AuthRequiredError,
  KeyBlacklistedError,
  KeyDeletedError,
} from '../lib/errors.ts';
import { logger } from '../lib/logger.ts';
import { hashApiKey, KEY_BODY_REGEX } from './auth-hash.ts';

export interface AuthenticatedKey {
  id: string;
  prefix: string;
  name: string;
  rateLimitPerMinute: number;
  allowNoOrigin: boolean;
}

export type AuthResult =
  | { ok: true; key: AuthenticatedKey }
  | { ok: false; error: AuthError | KeyBlacklistedError | KeyDeletedError };

/**
 * Dependencies for `authenticate`. `redis` is optional — when wired, it
 * backs the negative-lookup cache that short-circuits repeated bad keys
 * before they reach Postgres (AUDIT H-3). When absent (e.g. bare unit
 * tests), the DB round-trip still happens on every call.
 */
export interface AuthDeps {
  readonly repo: ApiKeyRepository;
  readonly redis?: Redis;
  readonly negCacheTtlSec?: number;
}

const BEARER_PREFIX = 'Bearer ';
const DEFAULT_NEG_CACHE_TTL_SEC = 60;
const NEG_CACHE_PREFIX = 'auth:miss:';

// Public-facing messages per SECURITY Rule 8. The internal messages are the first argument and
// go to logs; the second argument is what a client sees.
const MISSING_PUBLIC = 'Authentication required.';
const FAILED_PUBLIC = 'Authentication failed.';
const BLOCKED_PUBLIC = 'This API key has been blocked.';
const DELETED_PUBLIC = 'This API key has been deleted.';

/**
 * Key under which `auth:miss:<hash>` entries are stored. Exposed so
 * `ApiKeyRepository.create` can invalidate cached misses when a newly
 * minted key happens to match a previously-attempted one.
 */
export function negCacheKey(keyHash: string): string {
  return `${NEG_CACHE_PREFIX}${keyHash}`;
}

export async function authenticate(
  authorizationHeader: string | undefined,
  depsOrRepo: AuthDeps | ApiKeyRepository,
): Promise<AuthResult> {
  const deps: AuthDeps =
    'repo' in depsOrRepo && typeof depsOrRepo.repo === 'object'
      ? depsOrRepo
      : { repo: depsOrRepo as ApiKeyRepository };

  if (authorizationHeader === undefined) {
    return {
      ok: false,
      error: new AuthRequiredError('missing Authorization header', MISSING_PUBLIC),
    };
  }

  if (!authorizationHeader.startsWith(BEARER_PREFIX)) {
    return {
      ok: false,
      error: new AuthMalformedTokenError('non-Bearer Authorization header', MISSING_PUBLIC),
    };
  }

  const token = authorizationHeader.slice(BEARER_PREFIX.length);
  if (token.length === 0 || !KEY_BODY_REGEX.test(token)) {
    return {
      ok: false,
      error: new AuthMalformedTokenError('malformed bearer token', MISSING_PUBLIC),
    };
  }

  const hash = hashApiKey(token);

  // Negative cache: if this hash missed recently, skip the DB round-trip.
  // Redis read failures are logged but do not block auth — we degrade to
  // the plain DB lookup rather than 5xx-ing on a Redis hiccup.
  if (deps.redis) {
    try {
      const cached = await deps.redis.get(negCacheKey(hash));
      // Treat any non-empty string as a hit. `null` / `undefined` are the
      // miss path; the `typeof` guard is defensive against lenient mocks
      // in tests that don't model ioredis's `string | null` return shape.
      if (typeof cached === 'string' && cached.length > 0) {
        return {
          ok: false,
          error: new AuthInvalidCredentialsError('unknown key (cached)', FAILED_PUBLIC),
        };
      }
    } catch (err) {
      logger.warn({ err }, 'auth negative cache read failed — falling back to DB');
    }
  }

  const record = await deps.repo.findByHash(hash);
  if (record === null) {
    if (deps.redis) {
      const ttl = deps.negCacheTtlSec ?? DEFAULT_NEG_CACHE_TTL_SEC;
      // Fire-and-forget: a dropped cache write costs us at most one extra
      // DB lookup on the next attempt with this token. `Promise.resolve`
      // wrap tolerates test mocks that return undefined synchronously.
      Promise.resolve(deps.redis.set(negCacheKey(hash), '1', 'EX', ttl)).catch((err) => {
        logger.warn({ err }, 'auth negative cache write failed');
      });
    }
    return {
      ok: false,
      error: new AuthInvalidCredentialsError('unknown key', FAILED_PUBLIC),
    };
  }

  if (record.status === 'blacklisted') {
    return {
      ok: false,
      error: new KeyBlacklistedError('key blacklisted', BLOCKED_PUBLIC),
    };
  }
  if (record.status === 'deleted') {
    return {
      ok: false,
      error: new KeyDeletedError('key deleted', DELETED_PUBLIC),
    };
  }

  // Fire-and-forget last_used_at update. Do not await before returning success.
  // Per-request usage metrics (request_count, bytes_in, bytes_out, compute_ms) are recorded
  // in the server's tool wrapper via repo.recordUsage — not here. Auth only authenticates.
  void deps.repo.touchLastUsed(record.id).catch((err) => {
    logger.warn({ err, keyId: record.id }, 'failed to update last_used_at');
  });

  return {
    ok: true,
    key: {
      id: record.id,
      prefix: record.keyPrefix,
      name: record.name,
      rateLimitPerMinute: record.rateLimitPerMinute,
      allowNoOrigin: record.allowNoOrigin,
    },
  };
}
