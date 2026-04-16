import { z } from 'zod';
import { type NewsArticleRecord, NewsArticlesRepository } from '../shared/news/articles-repo.ts';
import { NEWS_SOURCES, type NewsSourceKey } from '../shared/news/sources.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const inputSchema = {} as const;

const articleSchema = z.object({
  rank: z.number().int().min(1).max(15).describe('Position within the source (1 = newest).'),
  title: z.string().describe('Article headline.'),
  url: z.string().describe('Canonical article URL.'),
  description: z
    .string()
    .nullable()
    .describe('Short summary from the RSS feed, or null when the feed provided none.'),
  content: z.string().describe('Full article body as Markdown (up to 50,000 characters).'),
  published_at: z
    .string()
    .nullable()
    .describe('ISO 8601 publication timestamp from the feed, or null when unknown.'),
});

const outputSchema = {
  fetched_at: z
    .string()
    .nullable()
    .describe(
      'ISO 8601 timestamp of the most recent cache refresh, or null if the cache is empty.',
    ),
  sources: z
    .array(
      z.object({
        key: z.string().describe("Source identifier: 'aftonbladet', 'expressen', or 'svt'."),
        name: z.string().describe('Human-readable source name.'),
        articles: z.array(articleSchema),
      }),
    )
    .describe('One entry per source, in the order Aftonbladet → Expressen → SVT.'),
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'get-news',
  title: 'Get News',
  description:
    'Returns the latest Swedish news headlines — up to 15 each from Aftonbladet, Expressen, and SVT Nyheter (45 total) — grouped by outlet. For every article: title, URL, short description (from the RSS feed), publication timestamp, and the full article body as Markdown. The cache is refreshed every 2 hours by the fetch-news worker. Use this to summarize recent Swedish news, answer questions about current events in Sweden, or compare how different outlets cover the same story. Returns isError when the cache has not been populated yet.',
  inputSchema,
  outputSchema,
  handler: async (_args, ctx: ToolContext): Promise<CallToolResult> => {
    ctx.logger.info('get-news invoked');
    const repo = new NewsArticlesRepository(ctx.db);
    const records = await repo.listAll();

    if (records.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: 'News cache is empty — the fetch-news worker has not populated it yet. Try again after the next scheduled refresh.',
          },
        ],
        isError: true,
      };
    }

    const grouped = groupBySource(records);
    const fetchedAt = latestFetchedAt(records);

    const text = formatText(grouped, fetchedAt);
    const structuredContent = {
      fetched_at: fetchedAt,
      sources: NEWS_SOURCES.map((source) => ({
        key: source.key,
        name: source.name,
        articles: (grouped.get(source.key) ?? []).map(toStructuredArticle),
      })),
    };

    return {
      content: [{ type: 'text', text }],
      structuredContent,
    };
  },
};

export default tool;

function groupBySource(
  records: readonly NewsArticleRecord[],
): Map<NewsSourceKey, NewsArticleRecord[]> {
  const map = new Map<NewsSourceKey, NewsArticleRecord[]>();
  for (const source of NEWS_SOURCES) map.set(source.key, []);
  for (const record of records) {
    const bucket = map.get(record.source);
    if (bucket !== undefined) bucket.push(record);
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => a.sourceRank - b.sourceRank);
  }
  return map;
}

function latestFetchedAt(records: readonly NewsArticleRecord[]): string | null {
  let latest: number | null = null;
  for (const r of records) {
    const ms = r.fetchedAt.getTime();
    if (latest === null || ms > latest) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function formatText(
  grouped: Map<NewsSourceKey, NewsArticleRecord[]>,
  fetchedAt: string | null,
): string {
  const header = fetchedAt
    ? `Senaste nyheter (cache uppdaterad ${fetchedAt}):`
    : 'Senaste nyheter:';
  const sections = NEWS_SOURCES.map((source) => {
    const articles = grouped.get(source.key) ?? [];
    const lines: string[] = [`=== ${source.name} ===`];
    if (articles.length === 0) {
      lines.push('', '(inga cachade artiklar)');
      return lines.join('\n');
    }
    for (const a of articles) {
      const published = a.publishedAt ? a.publishedAt.toISOString() : 'okänt';
      const desc = a.description ?? '(ingen sammanfattning)';
      lines.push(
        '',
        `${a.sourceRank}. ${a.title}`,
        `   URL: ${a.url}`,
        `   Publicerad: ${published}`,
        `   ${desc}`,
        '',
        a.content,
      );
    }
    return lines.join('\n');
  });
  return [header, '', ...sections].join('\n\n');
}

function toStructuredArticle(record: NewsArticleRecord): {
  rank: number;
  title: string;
  url: string;
  description: string | null;
  content: string;
  published_at: string | null;
} {
  return {
    rank: record.sourceRank,
    title: record.title,
    url: record.url,
    description: record.description,
    content: record.content,
    published_at: record.publishedAt ? record.publishedAt.toISOString() : null,
  };
}
