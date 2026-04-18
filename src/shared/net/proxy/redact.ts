/**
 * Credential-safe rendering of proxy URLs.
 *
 * `http://user:pass@host:port` → `http://***@host:port`
 *
 * Every code path that could place a proxy URL into a log line, error
 * message, metric label, or CLI echo MUST pipe it through this function
 * first. The shared Pino redact paths (src/lib/logger.ts) catch
 * `*.password` / `*.secret` / `*.token` but not a raw URL string — this
 * helper is the URL-specific layer on top.
 *
 * Implementation note: the function deliberately edits the *raw* string
 * instead of round-tripping through `URL.toString()`. WHATWG URL
 * normalises away default ports (`http://h:80` → `http://h/`), which
 * would produce logs that don't match what the operator configured.
 * Parsing is still used to detect whether credentials are present at
 * all, so a bare `http://host:port` stays identical to its input.
 */

const USERINFO_RE = /^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i;

export function maskProxyUrl(raw: string): string {
  if (typeof raw !== 'string') return raw;
  if (raw.length === 0) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[unparseable-url]';
  }
  if (url.username === '' && url.password === '') return raw;
  return raw.replace(USERINFO_RE, '$1***@');
}

/**
 * Apply `maskProxyUrl` to every entry in a comma-separated list.
 * Preserves order so round-robin logs read naturally.
 */
export function maskProxyUrlList(csv: string): string {
  if (!csv) return '';
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(maskProxyUrl)
    .join(',');
}
