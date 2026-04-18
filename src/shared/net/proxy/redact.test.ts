import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { maskProxyUrl, maskProxyUrlList } from './redact.ts';

describe('maskProxyUrl', () => {
  it('redacts user:pass from an http URL', () => {
    assert.equal(
      maskProxyUrl('http://alice:s3cret@proxy.example.com:8080'),
      'http://***@proxy.example.com:8080',
    );
  });

  it('redacts user:pass from an https URL', () => {
    assert.equal(
      maskProxyUrl('https://bob:pw@proxy.example.com:8443'),
      'https://***@proxy.example.com:8443',
    );
  });

  it('redacts credentials even when password is empty', () => {
    assert.equal(
      maskProxyUrl('http://alice@proxy.example.com:8080'),
      'http://***@proxy.example.com:8080',
    );
  });

  it('leaves an unauthenticated URL untouched (no marker added)', () => {
    const raw = 'http://proxy.example.com:8080/';
    assert.equal(maskProxyUrl(raw), raw);
  });

  it('preserves path, query, and fragment when redacting', () => {
    assert.equal(
      maskProxyUrl('http://u:p@proxy.example.com:8080/a/b?x=1#frag'),
      'http://***@proxy.example.com:8080/a/b?x=1#frag',
    );
  });

  it('handles non-URL garbage without leaking input', () => {
    assert.equal(maskProxyUrl('this is not a url'), '[unparseable-url]');
  });

  it('handles an empty string by returning it unchanged', () => {
    assert.equal(maskProxyUrl(''), '');
  });

  it('redacts unicode passwords', () => {
    // URL encodes the unicode password as percent-escapes — still must mask.
    const raw = `http://user:${encodeURIComponent('p∂ss')}@host:80`;
    assert.equal(maskProxyUrl(raw), 'http://***@host:80');
  });

  it('redacts reserved-character passwords via percent-encoding', () => {
    const raw = `http://user:${encodeURIComponent('p@ss:word/!')}@host:80`;
    assert.equal(maskProxyUrl(raw), 'http://***@host:80');
  });

  it('returns unchanged for non-string input', () => {
    // Defensive: callers should never pass non-strings, but if a cast
    // slips, we surface the original value rather than throwing.
    assert.equal(maskProxyUrl(undefined as unknown as string), undefined);
    assert.equal(maskProxyUrl(null as unknown as string), null);
  });
});

describe('maskProxyUrlList', () => {
  it('redacts each entry and preserves order', () => {
    assert.equal(
      maskProxyUrlList('http://a:1@h1:80,http://b:2@h2:81'),
      'http://***@h1:80,http://***@h2:81',
    );
  });

  it('trims whitespace between entries', () => {
    assert.equal(
      maskProxyUrlList('  http://a:1@h1:80 , http://b:2@h2:81 '),
      'http://***@h1:80,http://***@h2:81',
    );
  });

  it('drops empty entries silently', () => {
    assert.equal(
      maskProxyUrlList('http://a:1@h1:80,,http://b:2@h2:81'),
      'http://***@h1:80,http://***@h2:81',
    );
  });

  it('returns empty string for empty input', () => {
    assert.equal(maskProxyUrlList(''), '');
  });

  it('returns empty string for whitespace-only input', () => {
    assert.equal(maskProxyUrlList(',, ,  '), '');
  });

  it('renders single unparseable entries as [unparseable-url]', () => {
    assert.equal(
      maskProxyUrlList('http://a:1@h1:80,not-a-url'),
      'http://***@h1:80,[unparseable-url]',
    );
  });
});
