import { Buffer } from 'node:buffer';
import { assertPublicHostname } from './ssrf.ts';
import { USER_AGENT } from './user-agent.ts';

/**
 * Shared HTTP fetcher used by tools and workers. Implements the redirect
 * loop, per-hop SSRF guard, capped body read, DOMException → Error mapping,
 * and the canonical User-Agent. Callers format their own output around the
 * returned metadata + body buffer.
 */

export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 20_000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type AssertPublicHost = (hostname: string) => Promise<void>;

export interface FetchSafeOptions {
  /** Caller-scoped signal (tool context, worker context). Combined with the internal timeout. */
  readonly signal?: AbortSignal;
  /** Per-call timeout in ms. Default 20_000. */
  readonly timeoutMs?: number;
  /** Wire-byte cap on the response body. Default 2 MiB. */
  readonly maxBytes?: number;
  /** Maximum redirects to follow. Default 5. */
  readonly maxRedirects?: number;
  /** Extra request headers. User-Agent is always set by `fetchSafe`; other headers merge on top. */
  readonly headers?: Record<string, string>;
  /** Test seam: override global fetch. */
  readonly fetcher?: Fetcher;
  /** Test seam: override the SSRF guard. */
  readonly assertPublicHost?: AssertPublicHost;
}

export interface FetchSafeResult {
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string | null;
  readonly body: Buffer;
  readonly wireTruncated: boolean;
}

/**
 * Fetch a URL safely: follows redirects, runs the SSRF guard at every hop,
 * caps the response body, and maps abort/timeout DOMExceptions into ordinary
 * Errors with descriptive messages. Throws on every non-success path.
 */
export async function fetchSafe(
  url: string,
  options: FetchSafeOptions = {},
): Promise<FetchSafeResult> {
  const fetcher = options.fetcher ?? defaultFetcher;
  const guard = options.assertPublicHost ?? assertPublicHostname;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const combinedSignal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);

  let current: URL;
  try {
    current = new URL(url);
  } catch {
    throw new Error('invalid URL');
  }
  let redirects = 0;

  while (true) {
    // Re-check abort between hops so a shutdown signal doesn't have to wait
    // for the next network round-trip to observe the cancellation.
    if (combinedSignal.aborted) throw new Error('request aborted');

    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${current.protocol}" (only http and https allowed)`);
    }

    await guard(current.hostname);

    let response: Response;
    try {
      response = await fetcher(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: combinedSignal,
        headers: {
          'User-Agent': USER_AGENT,
          ...(options.headers ?? {}),
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(`timed out after ${timeoutMs}ms`);
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('request aborted');
      }
      throw new Error(`network error: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) {
        throw new Error(`redirect ${response.status} with no Location header`);
      }
      redirects++;
      if (redirects > maxRedirects) {
        throw new Error(`too many redirects (>${maxRedirects})`);
      }
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new Error(`redirect ${response.status} has invalid Location "${location}"`);
      }
      current = next;
      continue;
    }

    const { buffer, wireTruncated } = await readCappedBody(response, maxBytes);
    return {
      finalUrl: current.toString(),
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: buffer,
      wireTruncated,
    };
  }
}

const defaultFetcher: Fetcher = (url, init) => fetch(url, init);

async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; wireTruncated: boolean }> {
  if (!response.body) {
    return { buffer: Buffer.alloc(0), wireTruncated: false };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        const overflow = total - maxBytes;
        const keep = value.length - overflow;
        if (keep > 0) chunks.push(value.subarray(0, keep));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }

  return { buffer: Buffer.concat(chunks), wireTruncated: truncated };
}
