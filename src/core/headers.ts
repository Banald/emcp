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

// Strip a trailing `:port` from a Host header value before comparing
// against EMCP_PUBLIC_HOST. Browsers omit the port for scheme-default
// ports (80/443) but include it for any other port, and v2 publishes
// on 8443 by default — so the comparison MUST be port-insensitive or
// every request with a non-default port fails host validation.
//
// DNS-rebinding defense is unaffected: the hostname part is what an
// attacker would need to spoof, and that's still exact-matched.
// IPv6 literal: `[::1]:8443` → the `:port` only applies after the
// closing bracket, so `split` on the last `:` after `]` works.
function stripPort(host: string): string {
  if (host.startsWith('[')) {
    // IPv6: `[addr]:port` or just `[addr]`.
    const bracketEnd = host.indexOf(']');
    if (bracketEnd === -1) return host; // malformed; let the outer compare fail
    const tail = host.slice(bracketEnd + 1);
    if (tail.startsWith(':')) return host.slice(0, bracketEnd + 1);
    return host;
  }
  // IPv4 / DNS name: one `:` at most. Multiple colons means a raw IPv6
  // literal without brackets, which is invalid per RFC 3986 — treat as
  // unchanged and let the outer compare fail.
  const firstColon = host.indexOf(':');
  const lastColon = host.lastIndexOf(':');
  if (firstColon === -1 || firstColon !== lastColon) return host;
  return host.slice(0, firstColon);
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
  // Strip the port from both sides before comparing. This handles
  // EMCP_PUBLIC_HOST values that include an explicit port (test env,
  // some operator setups) AND the v2 default where clients always
  // include the non-default :8443 / :8080 in their Host header.
  const expected = stripPort(options.expectedHost);
  if (Array.isArray(hostRaw)) {
    // Multiple Host headers with different values — reject.
    const unique = new Set(hostRaw);
    if (unique.size !== 1) return { ok: false, reason: 'host-mismatch' };
    if (stripPort(hostRaw[0] ?? '') !== expected) {
      return { ok: false, reason: 'host-mismatch' };
    }
  } else if (stripPort(hostRaw) !== expected) {
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
