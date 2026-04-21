import { z } from 'zod';
import { config } from '../config.ts';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

// NOTE: web-search hits the internal SearXNG container (config.searxngUrl
// points at the compose bridge). Routing it through the external proxy
// pool would create a traffic loop (proxy → internet → SearXNG). SearXNG
// itself proxies its engine scrapers via EMCP_SEARXNG_OUTGOING_PROXIES; see
// infra/searxng/ and docs/ARCHITECTURE.md "Proxy egress".

const SEARXNG_ENGINES = 'google,brave,bing,qwant,startpage';
const FETCH_TIMEOUT_MS = 15_000;

interface SearXNGResult {
  title: string;
  url: string;
  content?: string;
  engine?: string;
}

interface SearXNGResponse {
  results: SearXNGResult[];
  query: string;
  number_of_results?: number;
}

const inputSchema = {
  query: z
    .string()
    .min(1)
    .max(400)
    .describe('The search query string. Be specific for better results.'),
  language: z
    .string()
    .min(2)
    .max(5)
    .default('sv')
    .describe('Search language code (BCP 47). Defaults to Swedish (sv).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(10)
    .describe('Maximum number of results to return. Range: 1-30.'),
  categories: z
    .string()
    .min(1)
    .max(100)
    .default('general')
    .describe(
      'SearXNG search category. Usually "general". Other options: "images", "news", "science".',
    ),
};

const outputSchema = {
  query: z.string().describe('The query that was executed.'),
  results: z
    .array(
      z.object({
        rank: z.number().int().min(1).describe('1-based rank of this result in the returned list.'),
        title: z.string().describe('Result title as reported by the upstream engine.'),
        url: z.string().describe('Result URL.'),
        snippet: z.string().describe('Snippet/excerpt, or "(no snippet)" when absent.'),
        source: z.string().describe('Originating search engine, or "unknown".'),
      }),
    )
    .describe('Ordered list of search results. Empty when no matches found.'),
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'web-search',
  title: 'Web Search',
  description:
    'Search the web using multiple search engines (Google, Brave, Bing, Qwant, Startpage) and return a list of results (title, URL, snippet) for a query. This is usually the FIRST tool to reach for whenever you need information from the web but do not already have a specific URL — it discovers the relevant pages so you can then pass a chosen result URL to `fetch-url` to read the full content. Prefer this over guessing URLs from memory: training-data URLs are frequently wrong, renamed, or outdated. Also prefer this when the user asks an open-ended question ("what is...", "latest news on...", "who is..."), when you need current or recent information, or when you need to compare multiple sources. The snippets alone are often enough to answer; drill into specific results with `fetch-url` only when more detail is required. Default language is Swedish (sv).',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async (
    { query, language, limit, categories },
    ctx: ToolContext,
  ): Promise<CallToolResult> => {
    const url = new URL('/search', config.searxngUrl);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('language', language);
    url.searchParams.set('engines', SEARXNG_ENGINES);
    url.searchParams.set('categories', categories);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      throw new TransientError(
        `SearXNG request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Web search is temporarily unavailable. Please try again.',
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `SearXNG returned HTTP ${response.status}`,
        'Web search is temporarily unavailable. Please try again.',
      );
    }

    const data = (await response.json()) as SearXNGResponse;
    const results = (data.results ?? []).slice(0, limit);

    if (results.length === 0) {
      return {
        content: [{ type: 'text', text: `No results found for "${query}".` }],
        structuredContent: { query, results: [] },
        isError: true,
      };
    }

    const structured = results.map((r, i) => ({
      rank: i + 1,
      title: r.title,
      url: r.url,
      snippet: r.content ?? '(no snippet)',
      source: r.engine ?? 'unknown',
    }));

    const lines = structured.map(
      (r) => `${r.rank}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}\n   Source: ${r.source}`,
    );
    const text = `Web search results for "${query}":\n\n${lines.join('\n\n')}`;

    return {
      content: [{ type: 'text', text }],
      structuredContent: { query, results: structured },
    };
  },
};

export default tool;
