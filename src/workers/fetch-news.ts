import { Buffer } from 'node:buffer';
import type { Logger } from 'pino';
import { extractArticle } from '../shared/html/extract.ts';
import { assertPublicHostname } from '../shared/net/ssrf.ts';
import type { ArticleToInsert } from '../shared/news/articles-repo.ts';
import { NewsArticlesRepository } from '../shared/news/articles-repo.ts';
import { type FeedItem, parseFeed } from '../shared/news/feed.ts';
import { ARTICLES_PER_SOURCE, NEWS_SOURCES, type NewsSource } from '../shared/news/sources.ts';
import type { WorkerDefinition } from '../shared/workers/types.ts';

const USER_AGENT = 'EchoMCP/0.3 (+fetch-news)';
const RSS_TIMEOUT_MS = 15_000;
const ARTICLE_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 50_000;
const DEFAULT_CONCURRENCY = 5;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
type AssertPublicHost = (hostname: string) => Promise<void>;

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
  let url: URL;
  try {
    url = new URL(source.rssUrl);
  } catch (err) {
    deps.logger.warn(
      { source: source.key, url: source.rssUrl, err: errMessage(err) },
      'feed URL invalid',
    );
    return null;
  }

  try {
    await deps.assertPublicHost(url.hostname);
  } catch (err) {
    deps.logger.warn({ source: source.key, err: errMessage(err) }, 'feed hostname rejected');
    return null;
  }

  const combined = AbortSignal.any([deps.signal, AbortSignal.timeout(RSS_TIMEOUT_MS)]);

  let response: Response;
  try {
    response = await deps.fetcher(source.rssUrl, {
      method: 'GET',
      signal: combined,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
      },
    });
  } catch (err) {
    deps.logger.warn({ source: source.key, err: errMessage(err) }, 'feed fetch failed');
    return null;
  }

  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    deps.logger.warn({ source: source.key, status: response.status }, 'feed fetch non-2xx');
    return null;
  }

  let xml: string;
  try {
    const { buffer } = await readCappedBody(response, MAX_RESPONSE_BYTES);
    xml = buffer.toString('utf-8');
  } catch (err) {
    deps.logger.warn({ source: source.key, err: errMessage(err) }, 'feed body read failed');
    return null;
  }

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
  const combined = AbortSignal.any([deps.signal, AbortSignal.timeout(ARTICLE_TIMEOUT_MS)]);
  let current: URL;
  try {
    current = new URL(initialUrl);
  } catch {
    throw new Error('invalid URL');
  }

  let redirects = 0;
  while (true) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error(`unsupported protocol "${current.protocol}"`);
    }
    await deps.assertPublicHost(current.hostname);

    let response: Response;
    try {
      response = await deps.fetcher(current.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: combined,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html, application/xhtml+xml',
        },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(`timed out after ${ARTICLE_TIMEOUT_MS}ms`);
      }
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error('request aborted');
      }
      throw new Error(`network error: ${errMessage(err)}`);
    }

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      void response.body?.cancel().catch(() => undefined);
      if (!location) throw new Error(`redirect ${response.status} with no Location`);
      redirects++;
      if (redirects > MAX_REDIRECTS) throw new Error(`too many redirects (>${MAX_REDIRECTS})`);
      try {
        current = new URL(location, current);
      } catch {
        throw new Error(`redirect ${response.status} has invalid Location "${location}"`);
      }
      continue;
    }

    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status}`);
    }

    const { buffer } = await readCappedBody(response, MAX_RESPONSE_BYTES);
    const charset = parseCharset(response.headers.get('content-type'));
    const body = decodeBody(buffer, charset);
    return { finalUrl: current.toString(), body };
  }
}

async function readCappedBody(
  response: Response,
  maxBytes: number,
): Promise<{ buffer: Buffer; wireTruncated: boolean }> {
  if (!response.body) return { buffer: Buffer.alloc(0), wireTruncated: false };
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

function parseCharset(raw: string | null): string {
  if (!raw) return 'utf-8';
  const parts = raw.split(';').slice(1);
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq).trim().toLowerCase() !== 'charset') continue;
    return p
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1')
      .toLowerCase();
  }
  return 'utf-8';
}

function decodeBody(body: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(body);
  } catch {
    return body.toString('utf8');
  }
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
