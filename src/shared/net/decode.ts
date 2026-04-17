import type { Buffer } from 'node:buffer';

/**
 * Returns the charset declared in a `Content-Type` header, defaulting to
 * `'utf-8'`. Lowercased, stripped of surrounding quotes.
 */
export function parseCharset(contentType: string | null): string {
  if (!contentType) return 'utf-8';
  const parts = contentType.split(';').slice(1);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    return part
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .toLowerCase();
  }
  return 'utf-8';
}

/**
 * Decodes a byte buffer to a string using the given charset. Falls back to
 * UTF-8 if the charset is unknown to `TextDecoder`.
 */
export function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return body.toString('utf8');
  }
}
