import type { Buffer } from 'node:buffer';
import { z } from 'zod';
import { extractArticle } from '../shared/html/extract.ts';
import { decodeBody, parseCharset } from '../shared/net/decode.ts';
import { fetchSafe } from '../shared/net/http.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MIN_MAX_LENGTH = 500;
const DEFAULT_MAX_LENGTH = 50_000;
const MAX_MAX_LENGTH = 100_000;

const ACCEPT_HEADER =
  'text/html, application/xhtml+xml, text/plain, application/json, application/xml, text/*;q=0.9, */*;q=0.5';

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
    'Fetch the full content of a specific HTTP or HTTPS URL. Use this tool ONLY when you already have a concrete URL — either provided by the user, returned by `web-search`, or linked from a page you already fetched. If you do not know the URL, call `web-search` first and then pass one of its result URLs here; do not guess URLs from training data, they are often wrong or stale. HTML pages are parsed with Mozilla Readability and converted to clean Markdown (title, byline, article body; navigation, ads, and footer chrome are removed). JSON, XML, plain text, RSS, and Atom are returned verbatim. Binary content types return only metadata. Redirects are followed safely (each hop is SSRF-checked). On ANY failure — timeout, network error, non-2xx status, disallowed URL, malformed response — a descriptive error message is returned as content with isError set; the tool never throws. Use for reading articles, documentation, feeds, API responses, or any specific web resource whose URL is known.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async ({ url, max_length }, ctx: ToolContext): Promise<CallToolResult> => {
    try {
      const outcome = await fetchSafe(url, {
        signal: ctx.signal,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        maxRedirects: MAX_REDIRECTS,
        headers: { Accept: ACCEPT_HEADER },
      });
      return formatOutcome(
        {
          finalUrl: outcome.finalUrl,
          status: outcome.status,
          contentType: outcome.contentType,
          body: outcome.body,
          wireTruncated: outcome.wireTruncated,
        },
        max_length,
      );
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
  const mime = (raw.split(';')[0] ?? '').trim().toLowerCase();
  return { mime, charset: parseCharset(raw) };
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
