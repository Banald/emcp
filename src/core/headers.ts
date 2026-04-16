export type HeaderValidationResult =
  | { ok: true; origin: string | null }
  | { ok: false; reason: 'host-mismatch' | 'origin-not-allowed' | 'origin-required' };

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | string[] | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return undefined;
}

export function validateHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: {
    expectedHost: string;
    allowedOrigins: readonly string[];
    requireOrigin: boolean;
  },
): HeaderValidationResult {
  const hostRaw = getHeader(headers, 'host');

  // Reject if Host header is missing, appears multiple times with different values,
  // or doesn't match the expected host.
  if (hostRaw === undefined) {
    return { ok: false, reason: 'host-mismatch' };
  }
  if (Array.isArray(hostRaw)) {
    // Multiple Host headers with different values — reject.
    const unique = new Set(hostRaw);
    if (unique.size !== 1) return { ok: false, reason: 'host-mismatch' };
    if (hostRaw[0] !== options.expectedHost) return { ok: false, reason: 'host-mismatch' };
  } else if (hostRaw !== options.expectedHost) {
    return { ok: false, reason: 'host-mismatch' };
  }

  const originRaw = getHeader(headers, 'origin');

  if (originRaw !== undefined) {
    // Origin present — must be in the allowlist (exact match, no wildcards).
    const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
    if (origin === undefined || !options.allowedOrigins.includes(origin)) {
      return { ok: false, reason: 'origin-not-allowed' };
    }
    return { ok: true, origin };
  }

  // Origin absent.
  if (options.requireOrigin) {
    return { ok: false, reason: 'origin-required' };
  }

  return { ok: true, origin: null };
}
