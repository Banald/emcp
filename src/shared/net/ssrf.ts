import { lookup } from 'node:dns/promises';
import { ValidationError } from '../../lib/errors.ts';

/**
 * Returns true if the given IP address is private, loopback, link-local,
 * or unspecified. Supports both IPv4 and IPv6 (including IPv4-mapped IPv6).
 */
export function isPrivateAddress(addr: string): boolean {
  // IPv4-mapped IPv6: ::ffff:a.b.c.d — extract the IPv4 part
  const v4mapped = addr.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4mapped?.[1]) return isPrivateIPv4(v4mapped[1]);

  // Plain IPv4
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr)) return isPrivateIPv4(addr);

  // IPv6
  return isPrivateIPv6(addr);
}

function isPrivateIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — current network (unspecified)
  if (a === 0) return true;
  // 10.0.0.0/8
  if (a === 10) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  return false;
}

function isPrivateIPv6(addr: string): boolean {
  const normalized = normalizeIPv6(addr);
  if (normalized === null) return true; // malformed → treat as private (reject)

  // ::1 — loopback
  if (normalized === '00000000000000000000000000000001') return true;
  // :: — unspecified
  if (normalized === '00000000000000000000000000000000') return true;

  // ::ffff:0:0/96 — IPv4-mapped IPv6 (RFC 4291). The dotted-quad fast path in
  // isPrivateAddress catches `::ffff:127.0.0.1`, but the hex form
  // `::ffff:7f00:1` (same IP, different notation) falls through to here.
  // Extract the last 32 bits as IPv4 and delegate.
  if (normalized.startsWith('00000000000000000000ffff')) {
    return isPrivateIPv4(extractIPv4FromHex(normalized.slice(24)));
  }
  // ::ffff:0:0:0/96 — IPv4-translated (SIIT, RFC 6145). Same shape, different prefix.
  if (normalized.startsWith('0000000000000000ffff0000')) {
    return isPrivateIPv4(extractIPv4FromHex(normalized.slice(24)));
  }

  const firstNibble = Number.parseInt(normalized.charAt(0), 16);

  // fe80::/10 — link-local (first 10 bits: 1111111010)
  if (
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb')
  )
    return true;

  // fc00::/7 — unique local (first 7 bits: 1111110)
  if (firstNibble === 0xf && (normalized[1] === 'c' || normalized[1] === 'd')) return true;

  return false;
}

// Decode the trailing 32 bits of a normalized IPv6 (8 hex chars) as IPv4 dotted-quad.
function extractIPv4FromHex(hex8: string): string {
  const a = Number.parseInt(hex8.slice(0, 2), 16);
  const b = Number.parseInt(hex8.slice(2, 4), 16);
  const c = Number.parseInt(hex8.slice(4, 6), 16);
  const d = Number.parseInt(hex8.slice(6, 8), 16);
  return `${a}.${b}.${c}.${d}`;
}

function normalizeIPv6(addr: string): string | null {
  // Expand :: into groups of zeros
  let full = addr.toLowerCase();

  // Handle :: expansion
  if (full.includes('::')) {
    const [left, right] = full.split('::');
    if (left === undefined || right === undefined) return null;
    const leftParts = left === '' ? [] : left.split(':');
    const rightParts = right === '' ? [] : right.split(':');
    const missingGroups = 8 - leftParts.length - rightParts.length;
    if (missingGroups < 0) return null;
    const middle = Array.from({ length: missingGroups }, () => '0000');
    full = [...leftParts, ...middle, ...rightParts].map((g) => g.padStart(4, '0')).join('');
  } else {
    const parts = full.split(':');
    if (parts.length !== 8) return null;
    full = parts.map((g) => g.padStart(4, '0')).join('');
  }

  if (full.length !== 32 || !/^[0-9a-f]{32}$/.test(full)) return null;
  return full;
}

/**
 * Resolves the hostname to all addresses and rejects if any are private,
 * loopback, link-local, or unspecified.
 *
 * Caller should re-resolve before fetch (TOCTOU defense) and call this
 * at both enqueue time and fetch time.
 */
export async function assertPublicHostname(hostname: string): Promise<void> {
  const records = await lookup(hostname, { all: true });
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new ValidationError(
        `hostname ${hostname} resolves to a non-public address`,
        'URLs resolving to internal addresses are not allowed.',
      );
    }
  }
}
