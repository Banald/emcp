import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 15_000;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})?$/;

const inputSchema = {
  title: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Page title to fetch (e.g. "Albert Einstein", "The Beatles"). Spaces are accepted; any form Wikipedia would resolve via its search is valid.',
    ),
  language: z
    .string()
    .min(2)
    .max(12)
    .regex(LANGUAGE_RE)
    .default('en')
    .describe(
      'Wikipedia language subdomain code (e.g. "en", "sv", "de", "zh-hans"). Defaults to "en".',
    ),
};

const outputSchema = {
  title: z.string().describe('Canonical page title (after any redirects).'),
  displaytitle: z.string().describe('HTML-formatted display title as shown on the site.'),
  description: z.string().nullable().describe('Short Wikidata-sourced description, or null.'),
  extract: z.string().describe('Plain-text lead-section extract.'),
  extract_html: z.string().describe('HTML-rendered lead-section extract.'),
  type: z
    .enum(['standard', 'disambiguation', 'no-extract', 'mainpage'])
    .describe('Article classification returned by the REST API.'),
  pageid: z.number().int().describe('MediaWiki page ID.'),
  language: z.string().describe('Language subdomain used (echoes input).'),
  url: z.string().describe('Desktop URL of the article page.'),
  mobile_url: z.string().nullable().describe('Mobile URL, when returned by the API.'),
  thumbnail_url: z
    .string()
    .nullable()
    .describe('URL of the summary thumbnail image, when available.'),
  original_image_url: z
    .string()
    .nullable()
    .describe('URL of the full-resolution original image, when available.'),
  timestamp: z.string().nullable().describe('Last-revision ISO 8601 timestamp, when provided.'),
  is_disambiguation: z
    .boolean()
    .describe('True when type === "disambiguation" — callers should refine the title.'),
};

interface SummaryResponse {
  readonly type?: string;
  readonly title?: string;
  readonly displaytitle?: string;
  readonly pageid?: number;
  readonly description?: string;
  readonly extract?: string;
  readonly extract_html?: string;
  readonly thumbnail?: { readonly source?: string };
  readonly originalimage?: { readonly source?: string };
  readonly lang?: string;
  readonly content_urls?: {
    readonly desktop?: { readonly page?: string };
    readonly mobile?: { readonly page?: string };
  };
  readonly timestamp?: string;
}

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'wikipedia-get',
  title: 'Wikipedia Get',
  description:
    'Fetch a Wikipedia page summary (lead section, description, thumbnail, content URL) via the REST v1 summary endpoint. Handles redirects automatically. Returns a typed summary on success, isError on HTTP 404 (page not found), and throws TransientError on upstream 5xx. Disambiguation pages succeed but are flagged via is_disambiguation=true so callers can refine the title. Pair with wikipedia-search to discover titles first.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 60 },

  handler: async ({ title, language }, ctx: ToolContext): Promise<CallToolResult> => {
    const encoded = encodeURIComponent(title.replace(/ /g, '_'));
    const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encoded}?redirect=true`;

    let response: Response;
    try {
      response = await fetchExternal(url, {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      throw new TransientError(
        `Wikipedia summary request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Wikipedia is temporarily unavailable. Please try again.',
      );
    }

    if (response.status === 404) {
      return {
        content: [
          {
            type: 'text',
            text: `Wikipedia page not found: "${title}" on ${language}.wikipedia.org. Try wikipedia-search to find the correct title.`,
          },
        ],
        isError: true,
      };
    }

    if (!response.ok) {
      throw new TransientError(
        `Wikipedia summary returned HTTP ${response.status}`,
        'Wikipedia is temporarily unavailable. Please try again.',
      );
    }

    const data = (await response.json()) as SummaryResponse;

    const type = normalizeType(data.type);
    const finalTitle = data.title ?? title;
    const canonicalUrl =
      data.content_urls?.desktop?.page ??
      `https://${language}.wikipedia.org/wiki/${encodeURIComponent((data.title ?? title).replace(/ /g, '_'))}`;

    const snapshot = {
      title: finalTitle,
      displaytitle: data.displaytitle ?? finalTitle,
      description: data.description ?? null,
      extract: data.extract ?? '',
      extract_html: data.extract_html ?? '',
      type,
      pageid: data.pageid ?? 0,
      language,
      url: canonicalUrl,
      mobile_url: data.content_urls?.mobile?.page ?? null,
      thumbnail_url: data.thumbnail?.source ?? null,
      original_image_url: data.originalimage?.source ?? null,
      timestamp: data.timestamp ?? null,
      is_disambiguation: type === 'disambiguation',
    };

    const text = formatText(snapshot);

    return {
      content: [{ type: 'text', text }],
      structuredContent: snapshot,
    };
  },
};

export default tool;

function normalizeType(raw: string | undefined): z.infer<typeof outputSchema.type> {
  if (
    raw === 'standard' ||
    raw === 'disambiguation' ||
    raw === 'no-extract' ||
    raw === 'mainpage'
  ) {
    return raw;
  }
  return 'standard';
}

interface FormatSnapshot {
  readonly title: string;
  readonly description: string | null;
  readonly extract: string;
  readonly url: string;
  readonly type: string;
  readonly is_disambiguation: boolean;
  readonly timestamp: string | null;
  readonly thumbnail_url: string | null;
}

function formatText(s: FormatSnapshot): string {
  const lines: string[] = [];
  lines.push(`# ${s.title}`);
  if (s.description) lines.push(`*${s.description}*`);
  if (s.is_disambiguation) {
    lines.push('');
    lines.push(
      '⚠ This is a disambiguation page — the extract below is the hatnote, not a full article. Refine the title and retry.',
    );
  }
  lines.push('');
  lines.push(s.extract || '(no extract returned)');
  lines.push('');
  lines.push(`URL: ${s.url}`);
  if (s.timestamp) lines.push(`Last edited: ${s.timestamp}`);
  if (s.thumbnail_url) lines.push(`Thumbnail: ${s.thumbnail_url}`);
  return lines.join('\n');
}
