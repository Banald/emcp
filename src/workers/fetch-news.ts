import type { Logger } from 'pino';
import { extractArticle } from '../shared/html/extract.ts';
import { decodeBody, parseCharset } from '../shared/net/decode.ts';
import { type AssertPublicHost, type Fetcher, fetchSafe } from '../shared/net/http.ts';
import { assertPublicHostname } from '../shared/net/ssrf.ts';
import type { ArticleToInsert } from '../shared/news/articles-repo.ts';
import { NewsArticlesRepository } from '../shared/news/articles-repo.ts';
import { type FeedItem, parseFeed } from '../shared/news/feed.ts';
import { ARTICLES_PER_SOURCE, NEWS_SOURCES, type NewsSource } from '../shared/news/sources.ts';
import type { WorkerDefinition } from '../shared/workers/types.ts';

const RSS_TIMEOUT_MS = 15_000;
const ARTICLE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 50_000;
const DEFAULT_CONCURRENCY = 5;

const RSS_ACCEPT =
  'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8';
const ARTICLE_ACCEPT = 'text/html, application/xhtml+xml';

export interface CollectDeps {
  readonly sources: readonly NewsSource[];
  readonly articlesPerSource: number;
  readonly signal: AbortSignal;
  readonly logger: Logger;
  readonly concurrency?: number;
  readonly fetcher?: Fetcher;
  readonly assertPublicHost?: AssertPublicHost;
}

interface QueuedFetch {
  readonly source: NewsSource;
  readonly rank: number;
  readonly item: FeedItem;
}

/**
 * Collect the latest `articlesPerSource` articles from every source in
 * `deps.sources`, in feed order. Never throws; per-source and per-article
 * failures are logged and skipped, and the caller receives whatever we could
 * successfully extract.
 */
export async function collectArticles(deps: CollectDeps): Promise<ArticleToInsert[]> {
  const fetcher = deps.fetcher ?? ((url, init) => fetch(url, init));
  const assertPublicHost = deps.assertPublicHost ?? assertPublicHostname;
  const concurrency = deps.concurrency ?? DEFAULT_CONCURRENCY;

  const queue: QueuedFetch[] = [];

  for (const source of deps.sources) {
    if (deps.signal.aborted) break;
    const items = await fetchFeed(source, {
      fetcher,
      assertPublicHost,
      signal: deps.signal,
      logger: deps.logger,
    });
    if (items === null) continue;
    const top = items.slice(0, deps.articlesPerSource);
    for (let i = 0; i < top.length; i++) {
      const item = top[i];
      if (item !== undefined) queue.push({ source, rank: i + 1, item });
    }
  }

  if (queue.length === 0) return [];

  const results: Array<ArticleToInsert | null> = new Array(queue.length).fill(null);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      if (deps.signal.aborted) return;
      const i = cursor++;
      if (i >= queue.length) return;
      const q = queue[i];
      if (q === undefined) return;
      try {
        const article = await fetchArticle(q, {
          fetcher,
          assertPublicHost,
          signal: deps.signal,
        });
        results[i] = article;
      } catch (err) {
        deps.logger.warn(
          { source: q.source.key, url: q.item.link, err: errMessage(err) },
          'article fetch failed',
        );
      }
    }
  };

  const workers = Array.from({ length: Math.max(1, concurrency) }, worker);
  await Promise.all(workers);

  return results.filter((r): r is ArticleToInsert => r !== null);
}

interface FeedFetchDeps {
  fetcher: Fetcher;
  assertPublicHost: AssertPublicHost;
  signal: AbortSignal;
  logger: Logger;
}

async function fetchFeed(source: NewsSource, deps: FeedFetchDeps): Promise<FeedItem[] | null> {
  let outcome: Awaited<ReturnType<typeof fetchSafe>>;
  try {
    // Feeds follow their own redirects naturally via the host CDN.
    // fetchSafe also handles URL validation and SSRF in one pass.
    outcome = await fetchSafe(source.rssUrl, {
      signal: deps.signal,
      timeoutMs: RSS_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: MAX_REDIRECTS,
      headers: { Accept: RSS_ACCEPT },
      fetcher: deps.fetcher,
      assertPublicHost: deps.assertPublicHost,
    });
  } catch (err) {
    deps.logger.warn({ source: source.key, err: errMessage(err) }, 'feed fetch failed');
    return null;
  }

  if (outcome.status < 200 || outcome.status >= 300) {
    deps.logger.warn({ source: source.key, status: outcome.status }, 'feed fetch non-2xx');
    return null;
  }

  const xml = outcome.body.toString('utf-8');
  const items = parseFeed(xml);
  if (items.length === 0) {
    deps.logger.warn({ source: source.key }, 'feed parsed but contained no items');
    return null;
  }
  return items;
}

interface ArticleFetchDeps {
  fetcher: Fetcher;
  assertPublicHost: AssertPublicHost;
  signal: AbortSignal;
}

async function fetchArticle(q: QueuedFetch, deps: ArticleFetchDeps): Promise<ArticleToInsert> {
  const html = await fetchHtml(q.item.link, deps);
  const extracted = extractArticle(html.body, html.finalUrl);
  const markdown = extracted.markdown.trim();
  if (markdown.length === 0) {
    throw new Error('extractor produced empty markdown');
  }
  const content =
    markdown.length > MAX_CONTENT_CHARS ? markdown.slice(0, MAX_CONTENT_CHARS) : markdown;
  const description = q.item.description?.trim();

  return {
    source: q.source.key,
    sourceRank: q.rank,
    url: html.finalUrl,
    title: q.item.title.trim(),
    description: description && description.length > 0 ? description : null,
    content,
    publishedAt: q.item.publishedAt ?? null,
  };
}

async function fetchHtml(
  initialUrl: string,
  deps: ArticleFetchDeps,
): Promise<{ finalUrl: string; body: string }> {
  const outcome = await fetchSafe(initialUrl, {
    signal: deps.signal,
    timeoutMs: ARTICLE_TIMEOUT_MS,
    maxBytes: MAX_RESPONSE_BYTES,
    maxRedirects: MAX_REDIRECTS,
    headers: { Accept: ARTICLE_ACCEPT },
    fetcher: deps.fetcher,
    assertPublicHost: deps.assertPublicHost,
  });
  if (outcome.status < 200 || outcome.status >= 300) {
    throw new Error(`HTTP ${outcome.status}`);
  }
  const body = decodeBody(outcome.body, parseCharset(outcome.contentType));
  return { finalUrl: outcome.finalUrl, body };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const worker: WorkerDefinition = {
  name: 'fetch-news',
  description:
    'Refreshes the Swedish news cache (Aftonbladet, Expressen, SVT — 15 articles each, 45 total) every two hours.',
  schedule: '0 */2 * * *',
  timezone: 'UTC',
  runOnStartup: true,
  timeoutMs: 4 * 60_000,
  handler: async (ctx) => {
    ctx.logger.info(
      { sources: NEWS_SOURCES.map((s) => s.key), per_source: ARTICLES_PER_SOURCE },
      'fetch-news starting',
    );
    const repo = new NewsArticlesRepository(ctx.db);
    const articles = await collectArticles({
      sources: NEWS_SOURCES,
      articlesPerSource: ARTICLES_PER_SOURCE,
      signal: ctx.signal,
      logger: ctx.logger,
    });

    if (articles.length === 0) {
      ctx.logger.warn('collected zero articles; leaving cache intact');
      return;
    }
    if (ctx.signal.aborted) {
      ctx.logger.warn({ collected: articles.length }, 'aborted before writing cache');
      return;
    }

    await repo.replaceAll(articles);
    ctx.logger.info({ count: articles.length }, 'news cache refreshed');
  },
};

export default worker;
