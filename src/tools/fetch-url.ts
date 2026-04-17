import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { extractArticle } from '../shared/html/extract.ts';
import { assertPublicHostname } from '../shared/net/ssrf.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MIN_MAX_LENGTH = 500;
const DEFAULT_MAX_LENGTH = 50_000;
const MAX_MAX_LENGTH = 100_000;

const inputSchema = {
  url: z
    .string()
    .min(1)
    .max(2048)
    .url()
    .describe(
      'Absolute http:// or https:// URL to fetch. URLs resolving to private, loopback, or link-local addresses are rejected.',
    ),
  max_length: z
    .number()
    .int()
    .min(MIN_MAX_LENGTH)
    .max(MAX_MAX_LENGTH)
    .default(DEFAULT_MAX_LENGTH)
    .describe(
      `Maximum characters of extracted content to return. Content past this point is truncated with a marker. Range ${MIN_MAX_LENGTH}-${MAX_MAX_LENGTH}. Default ${DEFAULT_MAX_LENGTH}.`,
    ),
};

const outputSchema = {
  final_url: z.string().describe('The URL after any redirects.'),
  status: z.number().int().describe('HTTP status code from the final (non-redirect) response.'),
  content_type: z
    .string()
    .nullable()
    .describe('Content-Type header from the final response, or null if absent.'),
  bytes: z
    .number()
    .int()
    .min(0)
    .describe('Body size on the wire, in bytes. Capped at the per-call limit.'),
  wire_truncated: z
    .boolean()
    .describe('True if the wire body was truncated at the per-call byte cap.'),
  title: z.string().optional().describe('Article title extracted by Readability (HTML only).'),
  byline: z.string().optional().describe('Article byline extracted by Readability (HTML only).'),
  site_name: z.string().optional().describe('Site name extracted by Readability (HTML only).'),
  extraction_fallback: z
    .boolean()
    .describe('True when Readability fell back to full-page markdown (HTML only).'),
  content_truncated: z
    .boolean()
    .describe('True when returned text content was capped at max_length.'),
};

interface FetchOutcome {
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: Buffer;
  wireTruncated: boolean;
}

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'fetch-url',
  title: 'Fetch URL',
  description:
    'Fetch an HTTP or HTTPS URL and return its content as LLM-readable text. HTML pages are parsed with Mozilla Readability and converted to clean Markdown (title, byline, article body; navigation, ads, and footer chrome are removed). JSON, XML, plain text, RSS, and Atom are returned verbatim. Binary content types return only metadata. Redirects are followed safely (each hop is SSRF-checked). On ANY failure — timeout, network error, non-2xx status, disallowed URL, malformed response — a descriptive error message is returned as content with isError set; the tool never throws. Use for articles, documentation, feeds, API responses, or any web resource.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async ({ url, max_length }, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info({ url, max_length }, 'fetch-url invoked');
    try {
      const outcome = await performFetch(url, ctx.signal);
      return formatOutcome(outcome, max_length);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.logger.warn({ url, err: message }, 'fetch-url failed');
      return {
        content: [
          {
            type: 'text',
            text: `Failed to fetch ${url}\nReason: ${message}`,
          },
        ],
        isError: true,
      };
    }
  },
};

export default tool;

async function performFetch(initialUrl: string, callerSignal: AbortSignal): Promise<FetchOutcome> {
  const combinedSignal = AbortSignal.any([callerSignal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  let current: URL;
  try {
    current = new URL(initialUrl);
  } catch {
    throw new Error('invalid URL');
  }
  let redirects = 0;

  while (true) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${current.protocol}" (only http and https allowed)`);
    }

    await assertPublicHostname(current.hostname);

    let response: Response;
    try {
      response = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: combinedSignal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html, application/xhtml+xml, text/plain, application/json, application/xml, text/*;q=0.9, */*;q=0.5',
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(`timed out after ${FETCH_TIMEOUT_MS}ms`);
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
      if (redirects > MAX_REDIRECTS) {
        throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
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

    const { buffer, wireTruncated } = await readCappedBody(response, MAX_RESPONSE_BYTES);
    return {
      finalUrl: current.toString(),
      status: response.status,
      contentType: response.headers.get('content-type'),
      body: buffer,
      wireTruncated,
    };
  }
}

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

function formatOutcome(outcome: FetchOutcome, maxLength: number): CallToolResult {
  const { finalUrl, status, contentType, body, wireTruncated } = outcome;
  const parsed = parseContentType(contentType);

  const header: string[] = [
    `URL: ${finalUrl}`,
    `Status: ${status}`,
    `Content-Type: ${contentType ?? '(none)'}`,
    `Bytes: ${body.length}${wireTruncated ? ' (wire-truncated)' : ''}`,
  ];

  const baseMetadata = {
    final_url: finalUrl,
    status,
    content_type: contentType,
    bytes: body.length,
    wire_truncated: wireTruncated,
    extraction_fallback: false,
    content_truncated: false,
  };

  if (status < 200 || status >= 300) {
    const snippet = isTextMime(parsed.mime) ? decodeBody(body, parsed.charset).slice(0, 2000) : '';
    return {
      content: [
        {
          type: 'text',
          text:
            `${header.join('\n')}\n\nUpstream responded with a non-2xx status.` +
            (snippet ? `\n\nResponse body (first 2000 chars):\n${snippet}` : ''),
        },
      ],
      structuredContent: baseMetadata,
      isError: true,
    };
  }

  if (!isTextMime(parsed.mime)) {
    return {
      content: [
        {
          type: 'text',
          text: `${header.join('\n')}\n\nContent is a non-text media type and was not extracted.`,
        },
      ],
      structuredContent: baseMetadata,
    };
  }

  const decoded = decodeBody(body, parsed.charset);
  let title: string | undefined;
  let byline: string | undefined;
  let siteName: string | undefined;
  let text: string;
  let extractionFallback = false;

  if (isHtmlMime(parsed.mime)) {
    const extracted = extractArticle(decoded, finalUrl);
    title = extracted.title;
    byline = extracted.byline;
    siteName = extracted.siteName;
    text = extracted.markdown;
    extractionFallback = extracted.fallback === true;
  } else {
    text = decoded.trim();
  }

  const truncatedText = text.length > maxLength ? text.slice(0, maxLength) : text;
  const contentTruncated = text.length > maxLength;

  if (title) header.push(`Title: ${title}`);
  if (byline) header.push(`Byline: ${byline}`);
  if (siteName) header.push(`Site: ${siteName}`);
  if (extractionFallback) {
    header.push(
      'Note: Readability did not find article content; returning full-page Markdown as fallback.',
    );
  }
  if (contentTruncated) {
    header.push(`Note: content truncated to ${maxLength} of ${text.length} characters.`);
  }

  const structured = {
    ...baseMetadata,
    ...(title !== undefined ? { title } : {}),
    ...(byline !== undefined ? { byline } : {}),
    ...(siteName !== undefined ? { site_name: siteName } : {}),
    extraction_fallback: extractionFallback,
    content_truncated: contentTruncated,
  };

  return {
    content: [
      {
        type: 'text',
        text: `${header.join('\n')}\n\n${truncatedText}`,
      },
    ],
    structuredContent: structured,
  };
}

function parseContentType(raw: string | null): { mime: string; charset: string } {
  if (!raw) return { mime: 'application/octet-stream', charset: 'utf-8' };
  const parts = raw.split(';').map((p) => p.trim());
  const mime = (parts[0] ?? '').toLowerCase();
  let charset = 'utf-8';
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const key = p.slice(0, eq).trim().toLowerCase();
    if (key !== 'charset') continue;
    charset = p
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .toLowerCase();
  }
  return { mime, charset };
}

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/ld+json' ||
    mime === 'application/xml' ||
    mime === 'application/xhtml+xml' ||
    mime === 'application/javascript' ||
    mime === 'application/rss+xml' ||
    mime === 'application/atom+xml' ||
    mime.endsWith('+json') ||
    mime.endsWith('+xml')
  );
}

function isHtmlMime(mime: string): boolean {
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return body.toString('utf8');
  }
}
