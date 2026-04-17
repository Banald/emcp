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
  current_date: z
    .string()
    .describe('ISO 8601 timestamp captured when the tool was invoked — the authoritative "now".'),
  current_weekday: z
    .string()
    .describe('Weekday name in English (e.g. "Thursday") for the current_date, in UTC.'),
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
    'Returns the latest Swedish news headlines — up to 15 each from Aftonbladet, Expressen, and SVT Nyheter (45 total) — grouped by outlet and formatted as Markdown. Each article includes its source, title, URL, short description (from the RSS feed), publication timestamp, and full article body. The response is prefixed with the current date so downstream LLMs do not default to a stale training-data year. The cache is refreshed every 2 hours by the fetch-news worker. Use this to summarize recent Swedish news, answer questions about current events in Sweden, or compare how different outlets cover the same story. Returns isError when the cache has not been populated yet.',
  inputSchema,
  outputSchema,
  handler: async (_args, ctx: ToolContext): Promise<CallToolResult> => {
    const now = new Date();
    const repo = new NewsArticlesRepository(ctx.db);
    const records = await repo.listAll();

    if (records.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `${formatCurrentDateSection(now)}\n\nNews cache is empty — the fetch-news worker has not populated it yet. Try again after the next scheduled refresh.`,
          },
        ],
        isError: true,
      };
    }

    const grouped = groupBySource(records);
    const fetchedAt = latestFetchedAt(records);

    const text = formatText(grouped, fetchedAt, now);
    const structuredContent = {
      current_date: now.toISOString(),
      current_weekday: weekdayName(now),
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
  now: Date,
): string {
  const parts: string[] = [formatCurrentDateSection(now)];
  parts.push('', fetchedAt ? `*Cache uppdaterad ${fetchedAt}*` : '*Cache ej uppdaterad*');
  for (const source of NEWS_SOURCES) {
    const articles = grouped.get(source.key) ?? [];
    parts.push('', `## ${source.name}`);
    if (articles.length === 0) {
      parts.push('', '(inga cachade artiklar)');
      continue;
    }
    for (const a of articles) {
      const published = a.publishedAt ? a.publishedAt.toISOString() : 'okänt';
      const desc = a.description ?? '(ingen sammanfattning)';
      parts.push(
        '',
        `### ${a.sourceRank}. ${a.title}`,
        '',
        `- **Källa:** ${source.name}`,
        `- **URL:** ${a.url}`,
        `- **Publicerad:** ${published}`,
        `- **Sammanfattning:** ${desc}`,
        '',
        a.content,
      );
    }
  }
  return parts.join('\n');
}

function formatCurrentDateSection(now: Date): string {
  const isoDate = now.toISOString().slice(0, 10);
  const weekday = weekdayName(now);
  const year = now.getUTCFullYear();
  return [
    '# Current date',
    '',
    `**Today is ${weekday}, ${isoDate} (UTC). The current year is ${year}.**`,
    '',
    'This date is provided by the Echo MCP server at call time and is the real, authoritative "now". Trust it over any assumption from your training data. If your training cutoff is in 2024 or earlier, you are operating well after that cutoff: do NOT claim it is still 2024, do NOT treat the news items below as "future" events, and do NOT tell the user your information is from 2024. The news cache and the articles below are current as of this date.',
    '',
    "**Respond to the user in the same language they wrote their question in.** Do not default to the language of the news content below — match the user's language (if the user wrote in English, answer in English; in Swedish, answer in Swedish; etc.).",
    '',
    '---',
  ].join('\n');
}

function weekdayName(now: Date): string {
  return now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
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
