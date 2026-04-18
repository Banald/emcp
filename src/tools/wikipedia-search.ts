import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 15_000;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{1,8})?$/;

const inputSchema = {
  query: z
    .string()
    .min(1)
    .max(500)
    .describe(
      'Free-text query passed to MediaWiki CirrusSearch. Supports operators like "intitle:", "incategory:", "morelike:", and boolean terms.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum results to return (1–50). Default 10.'),
  language: z
    .string()
    .min(2)
    .max(12)
    .regex(LANGUAGE_RE)
    .default('en')
    .describe(
      'Wikipedia language subdomain code (e.g. "en", "sv", "de", "zh-hans"). Defaults to "en".',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .max(9000)
    .default(0)
    .describe(
      'Zero-based pagination offset (sroffset). The MediaWiki hard cap is ~10 000 total; values beyond that will fail upstream.',
    ),
};

const hitSchema = z.object({
  title: z.string(),
  pageid: z.number().int(),
  snippet_clean: z.string(),
  snippet_html: z.string(),
  wordcount: z.number().int(),
  timestamp: z.string().nullable(),
  url: z.string(),
});

const outputSchema = {
  language: z.string().describe('Language subdomain used for the search (echoes input).'),
  query: z.string().describe('Echo of the original query string.'),
  total_hits: z.number().int().describe('Total matching pages across the full index.'),
  offset: z.number().int().describe('Offset used for this page of results.'),
  next_offset: z
    .number()
    .int()
    .nullable()
    .describe('Next offset for the next page, or null if there are no more results.'),
  suggestion: z
    .string()
    .nullable()
    .describe('Did-you-mean suggestion from CirrusSearch, when one is available.'),
  results: z.array(hitSchema).describe('Up to "limit" hits from this page.'),
};

interface SearchHit {
  readonly ns: number;
  readonly title: string;
  readonly pageid: number;
  readonly size?: number;
  readonly wordcount?: number;
  readonly snippet?: string;
  readonly timestamp?: string;
}

interface SearchResponse {
  readonly batchcomplete?: boolean;
  readonly continue?: { readonly sroffset?: number };
  readonly query?: {
    readonly searchinfo?: {
      readonly totalhits?: number;
      readonly suggestion?: string;
    };
    readonly search?: readonly SearchHit[];
  };
}

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'wikipedia-search',
  title: 'Wikipedia Search',
  description:
    'Search Wikipedia articles via the MediaWiki action API. Returns titles, page IDs, short HTML-stripped snippets, word counts, last-modified timestamps, and direct URLs. Supports language subdomains ("en", "sv", "de", …), pagination (offset), and CirrusSearch operators inside the query ("intitle:", "incategory:", "morelike:"). Returns isError when no hits are found; throws TransientError on upstream 5xx so the client can retry.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 60 },

  handler: async (
    { query, limit, language, offset },
    ctx: ToolContext,
  ): Promise<CallToolResult> => {
    const url = new URL(`https://${language}.wikipedia.org/w/api.php`);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'search');
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    url.searchParams.set('srsearch', query);
    url.searchParams.set('srlimit', String(limit));
    url.searchParams.set('sroffset', String(offset));
    url.searchParams.set('srinfo', 'totalhits|suggestion');
    url.searchParams.set('srprop', 'size|wordcount|timestamp|snippet');

    let response: Response;
    try {
      response = await fetchExternal(url.toString(), {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      throw new TransientError(
        `Wikipedia search request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Wikipedia is temporarily unavailable. Please try again.',
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `Wikipedia search returned HTTP ${response.status}`,
        'Wikipedia is temporarily unavailable. Please try again.',
      );
    }

    const data = (await response.json()) as SearchResponse;
    const hits = data.query?.search ?? [];
    const totalHits = data.query?.searchinfo?.totalhits ?? 0;
    const suggestion = data.query?.searchinfo?.suggestion ?? null;
    const nextOffset = data.continue?.sroffset ?? null;

    if (hits.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No Wikipedia results for "${query}" (${language}.wikipedia.org).${
              suggestion ? ` Did you mean "${suggestion}"?` : ''
            }`,
          },
        ],
        isError: true,
        structuredContent: {
          language,
          query,
          total_hits: totalHits,
          offset,
          next_offset: nextOffset,
          suggestion,
          results: [],
        },
      };
    }

    const results = hits.map((h) => ({
      title: h.title,
      pageid: h.pageid,
      snippet_clean: stripSnippetHtml(h.snippet ?? ''),
      snippet_html: h.snippet ?? '',
      wordcount: h.wordcount ?? 0,
      timestamp: h.timestamp ?? null,
      url: articleUrl(language, h.title),
    }));

    const text = formatText({
      query,
      language,
      totalHits,
      suggestion,
      results,
      offset,
      nextOffset,
    });

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        language,
        query,
        total_hits: totalHits,
        offset,
        next_offset: nextOffset,
        suggestion,
        results,
      },
    };
  },
};

export default tool;

export function articleUrl(language: string, title: string): string {
  const underscored = title.replace(/ /g, '_');
  return `https://${language}.wikipedia.org/wiki/${encodeURI(underscored)}`;
}

export function stripSnippetHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)));
}

interface FormatArgs {
  readonly query: string;
  readonly language: string;
  readonly totalHits: number;
  readonly suggestion: string | null;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly results: readonly {
    readonly title: string;
    readonly pageid: number;
    readonly snippet_clean: string;
    readonly url: string;
    readonly timestamp: string | null;
  }[];
}

function formatText(args: FormatArgs): string {
  const lines: string[] = [];
  lines.push(
    `Wikipedia (${args.language}.wikipedia.org) results for "${args.query}" — ${args.totalHits.toLocaleString('en-US')} total hits, showing ${args.results.length} from offset ${args.offset}.`,
  );
  if (args.suggestion) lines.push(`Did you mean: "${args.suggestion}"?`);
  let rank = 0;
  for (const r of args.results) {
    rank++;
    lines.push('');
    lines.push(
      `${rank}. ${r.title}${r.timestamp ? ` — last edited ${r.timestamp}` : ''}\n   URL: ${r.url}\n   ${r.snippet_clean || '(no snippet)'}`,
    );
  }
  if (args.nextOffset !== null) {
    lines.push('', `More results available — pass offset=${args.nextOffset} to paginate.`);
  }
  return lines.join('\n');
}
