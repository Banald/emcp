import { Buffer } from 'node:buffer';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';

export const KEY_PREFIX_LENGTH = 12;

// A generated key is `mcp_(live|test)_<43 base64url chars>` (32 random bytes → 43 chars unpadded).
export const KEY_BODY_REGEX = /^mcp_(live|test)_[A-Za-z0-9_-]{43}$/;

export function generateApiKey(prefix = 'mcp_live'): string {
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

export function hmacSha256Hex(input: string, secret: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

export function hashApiKey(rawKey: string): string {
  return hmacSha256Hex(rawKey, config.apiKeyHmacSecret);
}

export function verifyApiKey(provided: string, storedHash: string): boolean {
  const computed = hashApiKey(provided);
  // timingSafeEqual throws on length mismatch — guard first to keep the API total.
  if (computed.length !== storedHash.length) return false;
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHash, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractKeyPrefix(rawKey: string): string {
  return rawKey.slice(0, KEY_PREFIX_LENGTH);
}
