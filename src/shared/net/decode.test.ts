import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import { decodeBody, parseCharset } from './decode.ts';

describe('parseCharset', () => {
  it('returns utf-8 when the header is null or empty', () => {
    assert.equal(parseCharset(null), 'utf-8');
    assert.equal(parseCharset(''), 'utf-8');
  });

  it('returns utf-8 when no charset parameter is present', () => {
    assert.equal(parseCharset('text/html'), 'utf-8');
    assert.equal(parseCharset('application/json'), 'utf-8');
  });

  it('extracts the charset parameter', () => {
    assert.equal(parseCharset('text/html; charset=iso-8859-1'), 'iso-8859-1');
    assert.equal(parseCharset('text/plain; charset=UTF-16LE'), 'utf-16le');
  });

  it('handles quoted charset values', () => {
    assert.equal(parseCharset('text/html; charset="windows-1252"'), 'windows-1252');
  });

  it('ignores unrelated parameters', () => {
    assert.equal(parseCharset('text/html; boundary=xyz; charset=utf-8'), 'utf-8');
    assert.equal(parseCharset('text/plain; delsp=yes'), 'utf-8');
  });
});

describe('decodeBody', () => {
  it('decodes UTF-8 bodies', () => {
    assert.equal(decodeBody(Buffer.from('hello', 'utf-8'), 'utf-8'), 'hello');
  });

  it('decodes ISO-8859-1 bodies', () => {
    // 0xE5 is å in ISO-8859-1
    assert.equal(decodeBody(Buffer.from([0xe5]), 'iso-8859-1'), 'å');
  });

  it('falls back to utf-8 for an unknown charset', () => {
    assert.equal(decodeBody(Buffer.from('abc', 'utf-8'), 'totally-invalid'), 'abc');
  });

  it('returns an empty string for an empty buffer', () => {
    assert.equal(decodeBody(Buffer.alloc(0), 'utf-8'), '');
  });
});
