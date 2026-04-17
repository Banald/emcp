import type { ZodRawShape } from 'zod';

/**
 * Tools can mark individual input fields as sensitive by chaining
 * `.meta({ sensitive: true })` on the Zod schema. This module reads that
 * metadata at load time and returns a pure redactor that replaces the
 * sensitive keys with the constant `[REDACTED]` — used by the operational
 * logger so a future tool that accepts a bearer token or credential does
 * not leak the raw value through the entry log.
 */

export const REDACTED_VALUE = '[REDACTED]';

export type Redactor = (args: Record<string, unknown>) => Record<string, unknown>;

interface SchemaWithMeta {
  meta?: () => { sensitive?: unknown } | undefined;
}

function isSensitive(schema: unknown): boolean {
  const candidate = schema as SchemaWithMeta;
  const meta = typeof candidate.meta === 'function' ? candidate.meta() : undefined;
  return meta !== undefined && meta !== null && meta.sensitive === true;
}

/**
 * Walk a ZodRawShape once at load time and collect the field names flagged
 * `sensitive`. Returns a redactor; the identity function if nothing is
 * flagged so the hot path allocates nothing.
 */
export function buildRedactor(shape: ZodRawShape): Redactor {
  const sensitiveKeys = new Set<string>();
  for (const [key, schema] of Object.entries(shape)) {
    if (isSensitive(schema)) sensitiveKeys.add(key);
  }

  if (sensitiveKeys.size === 0) {
    return (args) => args;
  }

  return (args) => {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      redacted[key] = sensitiveKeys.has(key) ? REDACTED_VALUE : value;
    }
    return redacted;
  };
}
