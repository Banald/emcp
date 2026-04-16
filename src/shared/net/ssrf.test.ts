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
