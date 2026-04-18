import type { IncomingMessage } from 'node:http';

/**
 * Client-IP resolution for the MCP endpoint, specifically for the pre-auth
 * rate limiter (AUDIT H-3). Behind a trusted reverse proxy we want to key
 * the bucket on the real client; behind nothing we can only trust the
 * socket peer. `X-Forwarded-For` is only consulted when the upstream is
 * provably trusted (CIDR match against the configured allowlist), so a
 * direct attacker can never spoof the header to evade the limit.
 */

export interface ParsedCidr {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

const IPV4_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const V4_MAPPED_REGEX = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function parseCidrList(raw: string): readonly ParsedCidr[] {
  const out: ParsedCidr[] = [];
  for (const part of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    out.push(parseCidr(part));
  }
  if (out.length === 0) {
    throw new Error(`expected at least one CIDR, got: ${JSON.stringify(raw)}`);
  }
  return Object.freeze(out);
}

function parseCidr(cidr: string): ParsedCidr {
  const slash = cidr.indexOf('/');
  if (slash === -1) throw new Error(`malformed CIDR (missing '/'): ${cidr}`);
  const addr = cidr.slice(0, slash);
  const prefixStr = cidr.slice(slash + 1);
  const prefix = Number.parseInt(prefixStr, 10);
  if (!Number.isFinite(prefix) || prefix < 0 || String(prefix) !== prefixStr) {
    throw new Error(`malformed prefix in CIDR: ${cidr}`);
  }

  if (IPV4_REGEX.test(addr)) {
    if (prefix > 32) throw new Error(`IPv4 prefix >32: ${cidr}`);
    const bytes = parseIPv4(addr);
    if (bytes === null) throw new Error(`malformed IPv4 in CIDR: ${cidr}`);
    return { family: 4, bytes, prefixBits: prefix };
  }

  if (prefix > 128) throw new Error(`IPv6 prefix >128: ${cidr}`);
  const bytes = parseIPv6(addr);
  if (bytes === null) throw new Error(`malformed IPv6 in CIDR: ${cidr}`);
  return { family: 6, bytes, prefixBits: prefix };
}

/**
 * Parse an IPv4 literal to 4 raw bytes. Returns null if malformed.
 */
export function parseIPv4(addr: string): Uint8Array | null {
  if (!IPV4_REGEX.test(addr)) return null;
  const parts = addr.split('.').map(Number);
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return new Uint8Array(parts);
}

/**
 * Parse an IPv6 literal to 16 raw bytes. Supports `::` compression.
 * Returns null if malformed. Local helper rather than reusing the SSRF
 * module's normalizer so this module can stay independently focused.
 */
export function parseIPv6(addr: string): Uint8Array | null {
  const lower = addr.toLowerCase();
  let groups: string[];
  if (lower.includes('::')) {
    const [left, right] = lower.split('::');
    if (left === undefined || right === undefined) return null;
    const leftParts = left === '' ? [] : left.split(':');
    const rightParts = right === '' ? [] : right.split(':');
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    groups = [...leftParts, ...Array.from({ length: missing }, () => '0'), ...rightParts];
  } else {
    groups = lower.split(':');
  }
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i];
    if (g === undefined || !/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = Number.parseInt(g, 16);
    bytes[i * 2] = (n >> 8) & 0xff;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

export function isInCidr(ip: string, cidr: ParsedCidr): boolean {
  // Normalize IPv4-mapped IPv6 (Node emits `::ffff:127.0.0.1` when a v4
  // client connects to a dual-stack socket) into plain IPv4 so a CIDR
  // like 127.0.0.0/8 matches the loopback case operators actually have.
  const mapped = ip.match(V4_MAPPED_REGEX);
  if (IPV4_REGEX.test(ip) || mapped !== null) {
    if (cidr.family !== 4) return false;
    const bytes = parseIPv4(mapped ? (mapped[1] as string) : ip);
    if (bytes === null) return false;
    return bytesMatch(bytes, cidr.bytes, cidr.prefixBits);
  }
  if (cidr.family !== 6) return false;
  const bytes = parseIPv6(ip);
  if (bytes === null) return false;
  return bytesMatch(bytes, cidr.bytes, cidr.prefixBits);
}

function bytesMatch(actual: Uint8Array, expected: Uint8Array, prefixBits: number): boolean {
  const full = Math.floor(prefixBits / 8);
  const rem = prefixBits % 8;
  for (let i = 0; i < full; i++) if (actual[i] !== expected[i]) return false;
  if (rem === 0) return true;
  const mask = (0xff << (8 - rem)) & 0xff;
  return ((actual[full] ?? 0) & mask) === ((expected[full] ?? 0) & mask);
}

function isTrusted(ip: string, trusted: readonly ParsedCidr[]): boolean {
  for (const cidr of trusted) if (isInCidr(ip, cidr)) return true;
  return false;
}

/**
 * Pick the rate-limit key for an incoming request:
 *   - the socket peer, unless it is in the trusted-proxy CIDR list, in
 *     which case
 *   - the leftmost `X-Forwarded-For` entry (the original client).
 *
 * Returns `'unknown'` when the socket has no address (an edge case, but
 * the limiter treats these requests as a single bucket — which is the
 * correct posture for anonymous peers).
 */
export function getClientIp(req: IncomingMessage, trusted: readonly ParsedCidr[]): string {
  const connIp = req.socket.remoteAddress ?? '';
  if (!isTrusted(connIp, trusted)) {
    return connIp || 'unknown';
  }
  const xff = req.headers['x-forwarded-for'];
  const header = Array.isArray(xff) ? xff[0] : xff;
  if (!header) return connIp;
  const leftmost = header.split(',')[0]?.trim();
  return leftmost || connIp;
}
