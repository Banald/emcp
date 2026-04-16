import { z } from 'zod';
import { config } from '../config.ts';
import { TransientError } from '../lib/errors.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from './types.ts';

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

const tool: ToolDefinition<typeof inputSchema> = {
  name: 'web-search',
  title: 'Web Search',
  description:
    'Search the web using multiple search engines (Google, Brave, Bing, Qwant, Startpage). Returns titles, URLs, and snippets for each result. Default language is Swedish (sv). Use for finding current information, articles, documentation, or any web content.',
  inputSchema,
  rateLimit: { perMinute: 30 },

  handler: async (
    { query, language, limit, categories },
    ctx: ToolContext,
  ): Promise<CallToolResult> => {
    ctx.logger.info({ query, language, limit }, 'web-search invoked');

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
        headers: { Accept: 'application/json' },
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
        isError: true,
      };
    }

    const lines = results.map(
      (r, i) =>
        `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.content ?? '(no snippet)'}\n   Source: ${r.engine ?? 'unknown'}`,
    );
    const text = `Web search results for "${query}":\n\n${lines.join('\n\n')}`;

    return {
      content: [{ type: 'text', text }],
    };
  },
};

export default tool;
