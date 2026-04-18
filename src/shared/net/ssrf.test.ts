import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertPublicHostname, isPrivateAddress } from './ssrf.ts';

describe('isPrivateAddress', () => {
  describe('IPv4 private ranges', () => {
    it('rejects 10.0.0.0/8', () => {
      assert.equal(isPrivateAddress('10.0.0.1'), true);
      assert.equal(isPrivateAddress('10.255.255.255'), true);
    });

    it('rejects 172.16.0.0/12', () => {
      assert.equal(isPrivateAddress('172.16.0.1'), true);
      assert.equal(isPrivateAddress('172.31.255.255'), true);
      assert.equal(isPrivateAddress('172.20.0.1'), true);
    });

    it('rejects 192.168.0.0/16', () => {
      assert.equal(isPrivateAddress('192.168.0.1'), true);
      assert.equal(isPrivateAddress('192.168.1.1'), true);
      assert.equal(isPrivateAddress('192.168.255.255'), true);
    });

    it('rejects 127.0.0.0/8 (loopback)', () => {
      assert.equal(isPrivateAddress('127.0.0.1'), true);
      assert.equal(isPrivateAddress('127.255.255.255'), true);
    });

    it('rejects 169.254.0.0/16 (link-local)', () => {
      assert.equal(isPrivateAddress('169.254.0.1'), true);
      assert.equal(isPrivateAddress('169.254.255.255'), true);
    });

    it('rejects 0.0.0.0/8 (unspecified)', () => {
      assert.equal(isPrivateAddress('0.0.0.0'), true);
      assert.equal(isPrivateAddress('0.1.2.3'), true);
    });

    it('allows 172.15.x (just below /12)', () => {
      assert.equal(isPrivateAddress('172.15.255.255'), false);
    });

    it('allows 172.32.x (just above /12)', () => {
      assert.equal(isPrivateAddress('172.32.0.1'), false);
    });

    // AUDIT M-2 — additional RFC-reserved ranges.
    it('rejects 100.64.0.0/10 (CGNAT)', () => {
      assert.equal(isPrivateAddress('100.64.0.1'), true);
      assert.equal(isPrivateAddress('100.127.255.255'), true);
    });

    it('allows 100.63.x (just below CGNAT)', () => {
      assert.equal(isPrivateAddress('100.63.255.255'), false);
    });

    it('allows 100.128.x (just above CGNAT)', () => {
      assert.equal(isPrivateAddress('100.128.0.0'), false);
    });

    it('rejects 192.0.0.0/24 (IETF protocol assignments)', () => {
      assert.equal(isPrivateAddress('192.0.0.1'), true);
    });

    it('rejects 198.18.0.0/15 (benchmarking)', () => {
      assert.equal(isPrivateAddress('198.18.0.1'), true);
      assert.equal(isPrivateAddress('198.19.255.255'), true);
    });

    it('allows 198.17.x (just below benchmarking)', () => {
      assert.equal(isPrivateAddress('198.17.255.255'), false);
    });

    it('allows 198.20.x (just above benchmarking)', () => {
      assert.equal(isPrivateAddress('198.20.0.0'), false);
    });

    it('rejects multicast 224.0.0.0/4', () => {
      assert.equal(isPrivateAddress('224.0.0.1'), true);
      assert.equal(isPrivateAddress('239.255.255.255'), true);
    });

    it('allows 223.255.255.255 (just below multicast)', () => {
      assert.equal(isPrivateAddress('223.255.255.255'), false);
    });

    it('rejects reserved 240.0.0.0/4', () => {
      assert.equal(isPrivateAddress('240.0.0.1'), true);
      assert.equal(isPrivateAddress('254.255.255.255'), true);
    });

    it('rejects limited broadcast 255.255.255.255', () => {
      assert.equal(isPrivateAddress('255.255.255.255'), true);
    });
  });

  describe('IPv4 public addresses', () => {
    it('allows 8.8.8.8', () => {
      assert.equal(isPrivateAddress('8.8.8.8'), false);
    });

    it('allows 1.1.1.1', () => {
      assert.equal(isPrivateAddress('1.1.1.1'), false);
    });

    it('allows 93.184.216.34', () => {
      assert.equal(isPrivateAddress('93.184.216.34'), false);
    });
  });

  describe('IPv6 addresses', () => {
    it('rejects ::1 (loopback)', () => {
      assert.equal(isPrivateAddress('::1'), true);
    });

    it('rejects :: (unspecified)', () => {
      assert.equal(isPrivateAddress('::'), true);
    });

    it('rejects fe80::/10 (link-local)', () => {
      assert.equal(isPrivateAddress('fe80::1'), true);
      assert.equal(isPrivateAddress('fe80::abcd:ef01'), true);
    });

    it('rejects fc00::/7 (unique local)', () => {
      assert.equal(isPrivateAddress('fc00::1'), true);
      assert.equal(isPrivateAddress('fd12:3456:789a::1'), true);
    });

    it('allows 2606:4700::1 (Cloudflare public)', () => {
      assert.equal(isPrivateAddress('2606:4700::1'), false);
    });

    it('allows 2001:4860:4860::8888 (Google DNS)', () => {
      assert.equal(isPrivateAddress('2001:4860:4860::8888'), false);
    });

    // AUDIT M-3 — additional IPv6 reserved ranges.
    it('rejects ff00::/8 multicast', () => {
      assert.equal(isPrivateAddress('ff02::1'), true);
      assert.equal(isPrivateAddress('ff0e::1'), true);
    });

    it('rejects 2001:db8::/32 documentation', () => {
      assert.equal(isPrivateAddress('2001:db8::1'), true);
      assert.equal(isPrivateAddress('2001:db8:abcd::1'), true);
    });

    it('allows 2001:db9::1 (just outside documentation)', () => {
      assert.equal(isPrivateAddress('2001:db9::1'), false);
    });

    it('rejects fec0::/10 deprecated site-local', () => {
      assert.equal(isPrivateAddress('fec0::1'), true);
      assert.equal(isPrivateAddress('feff::1'), true);
    });

    it('rejects 2002::/16 6to4 wrapping a private IPv4', () => {
      // 2002:7f00:0001::/48 embeds 127.0.0.1 in bits 16–47.
      assert.equal(isPrivateAddress('2002:7f00:1::1'), true);
      // 2002:0a00:0001 → 10.0.0.1
      assert.equal(isPrivateAddress('2002:a00:1::1'), true);
    });

    it('allows 2002:0808:0808::1 (6to4 wrapping a public IPv4)', () => {
      // 2002:0808:0808 → 8.8.8.8
      assert.equal(isPrivateAddress('2002:808:808::1'), false);
    });

    it('rejects 64:ff9b::/96 NAT64 wrapping a private IPv4', () => {
      // 64:ff9b::7f00:1 embeds 127.0.0.1 in the trailing 32 bits.
      assert.equal(isPrivateAddress('64:ff9b::7f00:1'), true);
    });

    it('allows 64:ff9b::0808:0808 (NAT64 wrapping 8.8.8.8)', () => {
      assert.equal(isPrivateAddress('64:ff9b::808:808'), false);
    });
  });

  describe('IPv4-mapped IPv6', () => {
    it('rejects ::ffff:10.0.0.1', () => {
      assert.equal(isPrivateAddress('::ffff:10.0.0.1'), true);
    });

    it('rejects ::ffff:127.0.0.1', () => {
      assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
    });

    it('rejects ::ffff:192.168.1.1', () => {
      assert.equal(isPrivateAddress('::ffff:192.168.1.1'), true);
    });

    it('allows ::ffff:8.8.8.8', () => {
      assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
    });

    // Hex form of IPv4-mapped IPv6 (AUDIT H-1). Resolvers on BSD, musl, and
    // custom DNS can emit this form for an AAAA record pointing at a
    // private IPv4 — it must still be caught.
    it('rejects ::ffff:7f00:1 (hex form of 127.0.0.1)', () => {
      assert.equal(isPrivateAddress('::ffff:7f00:1'), true);
    });

    it('rejects ::ffff:a00:1 (hex form of 10.0.0.1)', () => {
      assert.equal(isPrivateAddress('::ffff:a00:1'), true);
    });

    it('rejects ::ffff:ac10:1 (hex form of 172.16.0.1)', () => {
      assert.equal(isPrivateAddress('::ffff:ac10:1'), true);
    });

    it('rejects ::ffff:c0a8:1 (hex form of 192.168.0.1)', () => {
      assert.equal(isPrivateAddress('::ffff:c0a8:1'), true);
    });

    it('allows ::ffff:8080:8 (hex form of 128.128.128.8, public)', () => {
      assert.equal(isPrivateAddress('::ffff:8080:8'), false);
    });

    it('rejects ::FFFF:7F00:1 (mixed case hex form of 127.0.0.1)', () => {
      assert.equal(isPrivateAddress('::FFFF:7F00:1'), true);
    });

    it('rejects ::ffff:0:7f00:1 (IPv4-translated form of 127.0.0.1)', () => {
      assert.equal(isPrivateAddress('::ffff:0:7f00:1'), true);
    });
  });
});

describe('assertPublicHostname', () => {
  it('throws for localhost', async () => {
    await assert.rejects(
      () => assertPublicHostname('localhost'),
      (err: Error) => err.message.includes('non-public address'),
    );
  });

  it('throws for 127.0.0.1 (as hostname string)', async () => {
    await assert.rejects(
      () => assertPublicHostname('127.0.0.1'),
      (err: Error) => err.message.includes('non-public address'),
    );
  });

  it('resolves without error for a public hostname', async () => {
    // dns.lookup resolves real hostnames; use one known to be public
    // If DNS is unavailable in CI, this test may need to be skipped
    await assert.doesNotReject(() => assertPublicHostname('one.one.one.one'));
  });
});
