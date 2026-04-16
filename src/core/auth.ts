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

const BEARER_PREFIX = 'Bearer ';

// Public-facing messages per SECURITY Rule 8. The internal messages are the first argument and
// go to logs; the second argument is what a client sees.
const MISSING_PUBLIC = 'Authentication required.';
const FAILED_PUBLIC = 'Authentication failed.';
const BLOCKED_PUBLIC = 'This API key has been blocked.';
const DELETED_PUBLIC = 'This API key has been deleted.';

export async function authenticate(
  authorizationHeader: string | undefined,
  repo: ApiKeyRepository,
): Promise<AuthResult> {
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
  const record = await repo.findByHash(hash);
  if (record === null) {
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
  void repo.touchLastUsed(record.id).catch((err) => {
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
