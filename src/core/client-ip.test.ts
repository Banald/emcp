import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { describe, it } from 'node:test';
import { getClientIp, isInCidr, parseCidrList, parseIPv4, parseIPv6 } from './client-ip.ts';

const fakeReq = (
  remoteAddress: string | undefined,
  headers: Record<string, string | string[] | undefined> = {},
): IncomingMessage =>
  ({
    socket: { remoteAddress },
    headers,
  }) as unknown as IncomingMessage;

describe('parseIPv4', () => {
  it('parses 127.0.0.1', () => {
    const bytes = parseIPv4('127.0.0.1');
    assert.ok(bytes);
    assert.deepEqual(Array.from(bytes as Uint8Array), [127, 0, 0, 1]);
  });

  it('rejects 999.0.0.1', () => {
    assert.equal(parseIPv4('999.0.0.1'), null);
  });

  it('rejects nonsense', () => {
    assert.equal(parseIPv4('not-an-ip'), null);
  });
});

describe('parseIPv6', () => {
  it('parses ::1 (loopback)', () => {
    const bytes = parseIPv6('::1');
    assert.ok(bytes);
    const b = bytes as Uint8Array;
    for (let i = 0; i < 15; i++) assert.equal(b[i], 0);
    assert.equal(b[15], 1);
  });

  it('parses a fully-expanded address', () => {
    const bytes = parseIPv6('2001:0db8:0000:0000:0000:0000:0000:0001');
    assert.ok(bytes);
    assert.equal((bytes as Uint8Array)[0], 0x20);
    assert.equal((bytes as Uint8Array)[1], 0x01);
    assert.equal((bytes as Uint8Array)[15], 0x01);
  });

  it('rejects too many groups', () => {
    assert.equal(parseIPv6('1:2:3:4:5:6:7:8:9'), null);
  });

  it('rejects non-hex groups', () => {
    assert.equal(parseIPv6('zzzz::1'), null);
  });
});

describe('parseCidrList', () => {
  it('parses IPv4 and IPv6 entries', () => {
    const cidrs = parseCidrList('127.0.0.0/8,::1/128');
    assert.equal(cidrs.length, 2);
    assert.equal(cidrs[0]?.family, 4);
    assert.equal(cidrs[0]?.prefixBits, 8);
    assert.equal(cidrs[1]?.family, 6);
    assert.equal(cidrs[1]?.prefixBits, 128);
  });

  it('throws on empty input', () => {
    assert.throws(() => parseCidrList(''), /at least one CIDR/);
  });

  it('throws on whitespace-only input', () => {
    assert.throws(() => parseCidrList(' , , '), /at least one CIDR/);
  });

  it('throws on missing slash', () => {
    assert.throws(() => parseCidrList('127.0.0.1'), /missing '\/'/);
  });

  it('throws on IPv4 prefix >32', () => {
    assert.throws(() => parseCidrList('10.0.0.0/40'), /prefix >32/);
  });

  it('throws on IPv6 prefix >128', () => {
    assert.throws(() => parseCidrList('::1/200'), /prefix >128/);
  });

  it('throws on malformed IPv4 octet', () => {
    assert.throws(() => parseCidrList('10.0.0.999/8'), /malformed IPv4/);
  });

  it('throws on malformed IPv6', () => {
    assert.throws(() => parseCidrList('not-an-ip/8'), /malformed IPv6/);
  });

  it('throws on non-numeric prefix', () => {
    assert.throws(() => parseCidrList('127.0.0.0/abc'), /malformed prefix/);
  });
});

describe('isInCidr', () => {
  it('matches an IPv4 in 127.0.0.0/8', () => {
    const [cidr] = parseCidrList('127.0.0.0/8');
    assert.equal(isInCidr('127.0.0.1', cidr as never), true);
    assert.equal(isInCidr('127.255.255.255', cidr as never), true);
  });

  it('rejects an IPv4 outside 127.0.0.0/8', () => {
    const [cidr] = parseCidrList('127.0.0.0/8');
    assert.equal(isInCidr('128.0.0.1', cidr as never), false);
  });

  it('handles non-byte-aligned prefixes (10.0.0.0/12)', () => {
    const [cidr] = parseCidrList('10.0.0.0/12');
    assert.equal(isInCidr('10.15.255.255', cidr as never), true);
    assert.equal(isInCidr('10.16.0.0', cidr as never), false);
  });

  it('matches IPv4-mapped IPv6 against an IPv4 CIDR', () => {
    const [cidr] = parseCidrList('127.0.0.0/8');
    assert.equal(isInCidr('::ffff:127.0.0.1', cidr as never), true);
  });

  it('does not match IPv4 against an IPv6 CIDR', () => {
    const [cidr] = parseCidrList('::1/128');
    assert.equal(isInCidr('127.0.0.1', cidr as never), false);
  });

  it('does not match IPv6 against an IPv4 CIDR', () => {
    const [cidr] = parseCidrList('127.0.0.0/8');
    assert.equal(isInCidr('::1', cidr as never), false);
  });

  it('matches IPv6 loopback', () => {
    const [cidr] = parseCidrList('::1/128');
    assert.equal(isInCidr('::1', cidr as never), true);
  });

  it('rejects IPv6 outside the prefix', () => {
    const [cidr] = parseCidrList('2001:db8::/32');
    assert.equal(isInCidr('2001:db8::1', cidr as never), true);
    assert.equal(isInCidr('2001:db9::1', cidr as never), false);
  });

  it('returns false for malformed IPv4 input', () => {
    const [cidr] = parseCidrList('127.0.0.0/8');
    assert.equal(isInCidr('999.999.999.999', cidr as never), false);
  });

  it('returns false for malformed IPv6 input', () => {
    const [cidr] = parseCidrList('::1/128');
    assert.equal(isInCidr('::zzz', cidr as never), false);
  });
});

describe('getClientIp', () => {
  const trusted = parseCidrList('127.0.0.0/8,::1/128');

  it('returns the socket peer when not trusted', () => {
    const req = fakeReq('8.8.8.8', { 'x-forwarded-for': '1.2.3.4' });
    assert.equal(getClientIp(req, trusted), '8.8.8.8');
  });

  it('returns the leftmost XFF entry when the peer is trusted', () => {
    const req = fakeReq('127.0.0.1', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    assert.equal(getClientIp(req, trusted), '1.2.3.4');
  });

  it('handles IPv6 loopback as trusted', () => {
    const req = fakeReq('::1', { 'x-forwarded-for': '9.9.9.9' });
    assert.equal(getClientIp(req, trusted), '9.9.9.9');
  });

  it('falls back to the connection IP when XFF is missing', () => {
    const req = fakeReq('127.0.0.1', {});
    assert.equal(getClientIp(req, trusted), '127.0.0.1');
  });

  it('falls back to the connection IP when XFF is an empty string', () => {
    const req = fakeReq('127.0.0.1', { 'x-forwarded-for': '' });
    assert.equal(getClientIp(req, trusted), '127.0.0.1');
  });

  it('falls back to the connection IP when XFF is all whitespace', () => {
    const req = fakeReq('127.0.0.1', { 'x-forwarded-for': '  , ' });
    assert.equal(getClientIp(req, trusted), '127.0.0.1');
  });

  it('picks the first entry when XFF is a string[] (node raw form)', () => {
    const req = fakeReq('127.0.0.1', { 'x-forwarded-for': ['2.3.4.5', '6.7.8.9'] });
    assert.equal(getClientIp(req, trusted), '2.3.4.5');
  });

  it('returns "unknown" when the socket has no address', () => {
    const req = fakeReq(undefined);
    assert.equal(getClientIp(req, trusted), 'unknown');
  });

  it('honours IPv4-mapped IPv6 trusted proxies', () => {
    const req = fakeReq('::ffff:127.0.0.1', { 'x-forwarded-for': '5.5.5.5' });
    assert.equal(getClientIp(req, trusted), '5.5.5.5');
  });
});
