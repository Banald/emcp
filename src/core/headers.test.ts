import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateHeaders } from './headers.ts';

const defaults = {
  expectedHost: 'mcp.example.com',
  allowedOrigins: ['https://app.example.com', 'https://admin.example.com'],
  requireOrigin: false,
};

describe('validateHeaders', () => {
  describe('Host header', () => {
    it('accepts a matching Host header', () => {
      const result = validateHeaders({ host: 'mcp.example.com' }, defaults);
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('rejects a mismatched Host header', () => {
      const result = validateHeaders({ host: 'evil.example.com' }, defaults);
      assert.deepEqual(result, { ok: false, reason: 'host-mismatch' });
    });

    it('rejects a missing Host header', () => {
      const result = validateHeaders({}, defaults);
      assert.deepEqual(result, { ok: false, reason: 'host-mismatch' });
    });

    it('rejects duplicate Host headers with different values', () => {
      const result = validateHeaders({ host: ['mcp.example.com', 'evil.example.com'] }, defaults);
      assert.deepEqual(result, { ok: false, reason: 'host-mismatch' });
    });

    it('accepts duplicate Host headers with identical values', () => {
      const result = validateHeaders({ host: ['mcp.example.com', 'mcp.example.com'] }, defaults);
      assert.deepEqual(result, { ok: true, origin: null });
    });

    // v2: rootless defaults publish Caddy on host ports 8080/8443, so
    // browsers send `Host: mcp.example.com:8443`. The validator must
    // accept that while still exact-matching the hostname part
    // (DNS-rebinding defense is on the hostname, not the port).
    it('accepts a matching Host header with an explicit port', () => {
      const result = validateHeaders({ host: 'mcp.example.com:8443' }, defaults);
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('accepts any port on the matching hostname', () => {
      const result = validateHeaders({ host: 'mcp.example.com:12345' }, defaults);
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('rejects a mismatched hostname even with a port suffix', () => {
      const result = validateHeaders({ host: 'evil.example.com:8443' }, defaults);
      assert.deepEqual(result, { ok: false, reason: 'host-mismatch' });
    });

    it('accepts an IPv6-literal Host with a port', () => {
      const result = validateHeaders(
        { host: '[::1]:8443' },
        { ...defaults, expectedHost: '[::1]' },
      );
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('rejects a raw IPv6 literal without brackets (RFC 3986 violation)', () => {
      const result = validateHeaders({ host: '::1:8443' }, { ...defaults, expectedHost: '::1' });
      assert.deepEqual(result, { ok: false, reason: 'host-mismatch' });
    });
  });

  describe('Origin header', () => {
    it('accepts an allowed Origin', () => {
      const result = validateHeaders(
        { host: 'mcp.example.com', origin: 'https://app.example.com' },
        defaults,
      );
      assert.deepEqual(result, { ok: true, origin: 'https://app.example.com' });
    });

    it('rejects a disallowed Origin', () => {
      const result = validateHeaders(
        { host: 'mcp.example.com', origin: 'https://evil.example.com' },
        defaults,
      );
      assert.deepEqual(result, { ok: false, reason: 'origin-not-allowed' });
    });

    it('accepts a missing Origin when requireOrigin is false', () => {
      const result = validateHeaders(
        { host: 'mcp.example.com' },
        { ...defaults, requireOrigin: false },
      );
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('rejects a missing Origin when requireOrigin is true', () => {
      const result = validateHeaders(
        { host: 'mcp.example.com' },
        { ...defaults, requireOrigin: true },
      );
      assert.deepEqual(result, { ok: false, reason: 'origin-required' });
    });

    it('accepts second allowed Origin', () => {
      const result = validateHeaders(
        { host: 'mcp.example.com', origin: 'https://admin.example.com' },
        defaults,
      );
      assert.deepEqual(result, { ok: true, origin: 'https://admin.example.com' });
    });
  });

  describe('case-insensitive header lookup', () => {
    it('accepts Host in mixed case', () => {
      const result = validateHeaders({ Host: 'mcp.example.com' }, defaults);
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('accepts HOST in upper case', () => {
      const result = validateHeaders({ HOST: 'mcp.example.com' }, defaults);
      assert.deepEqual(result, { ok: true, origin: null });
    });

    it('accepts Origin in mixed case', () => {
      const result = validateHeaders(
        { Host: 'mcp.example.com', ORIGIN: 'https://app.example.com' },
        defaults,
      );
      assert.deepEqual(result, { ok: true, origin: 'https://app.example.com' });
    });
  });

  describe('edge cases', () => {
    it('checks Host before Origin', () => {
      const result = validateHeaders(
        { host: 'evil.example.com', origin: 'https://app.example.com' },
        defaults,
      );
      assert.deepEqual(result, { ok: false, reason: 'host-mismatch' });
    });

    it('rejects empty origin against allowlist', () => {
      const result = validateHeaders(
        { host: 'mcp.example.com', origin: '' },
        { ...defaults, allowedOrigins: ['https://app.example.com'] },
      );
      assert.deepEqual(result, { ok: false, reason: 'origin-not-allowed' });
    });
  });
});
