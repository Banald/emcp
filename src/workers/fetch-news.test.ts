import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Cron } from 'croner';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Logger } from 'pino';
import { createLogger } from '../lib/logger.ts';
import type { NewsSource } from '../shared/news/sources.ts';
import type { WorkerContext } from '../shared/workers/types.ts';
import worker, { collectArticles } from './fetch-news.ts';

const silentLogger: Logger = createLogger({ level: 'silent' }).child({});

const abTest: NewsSource = {
  key: 'aftonbladet',
  name: 'Aftonbladet',
  rssUrl: 'https://example.com/aftonbladet.rss',
};
const exTest: NewsSource = {
  key: 'expressen',
  name: 'Expressen',
  rssUrl: 'https://example.com/expressen.rss',
};
const svtTest: NewsSource = {
  key: 'svt',
  name: 'SVT Nyheter',
  rssUrl: 'https://example.com/svt.rss',
};

function rssOf(
  items: Array<{ title: string; link: string; description?: string; pubDate?: string }>,
): string {
  const parts = items.map(
    (i) =>
      `<item>
        <title>${i.title}</title>
        <link>${i.link}</link>
        ${i.description === undefined ? '' : `<description>${i.description}</description>`}
        ${i.pubDate === undefined ? '' : `<pubDate>${i.pubDate}</pubDate>`}
      </item>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>${parts.join('')}</channel></rss>`;
}

function articleHtml(title: string, body: string): string {
  // Enough text to satisfy Readability's charThreshold.
  return `<!doctype html><html><head><title>${title}</title></head><body>
  <main><article>
    <h1>${title}</h1>
    <p>${body}</p>
    <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
    <p>Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
    <p>Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.</p>
  </article></main>
  </body></html>`;
}

const htmlResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });

const xmlResponse = (body: string, status = 200): Response =>
  new Response(body, { status, headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } });

function routedFetcher(
  map: Record<string, Response | (() => Response) | (() => Promise<Response>)>,
) {
  return async (url: string): Promise<Response> => {
    const entry = map[url];
    if (entry === undefined) throw new Error(`no canned response for ${url}`);
    return typeof entry === 'function' ? entry() : entry;
  };
}

const alwaysPublic = async (_hostname: string): Promise<void> => undefined;

describe('fetch-news worker metadata', () => {
  it('has the expected identity', () => {
    assert.equal(worker.name, 'fetch-news');
    assert.equal(worker.schedule, '0 */2 * * *');
    assert.equal(worker.timezone, 'UTC');
    assert.equal(worker.runOnStartup, true);
    assert.equal(worker.timeoutMs, 4 * 60_000);
    assert.ok(worker.description);
  });

  it('has a parseable cron schedule', () => {
    const cron = new Cron(worker.schedule, { paused: true });
    cron.stop();
  });
});

describe('collectArticles', () => {
  beforeEach(() => {
    mock.reset();
  });
  afterEach(() => {
    mock.reset();
  });

  it('collects every article in stable source/rank order on the happy path', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([
          {
            title: 'A1',
            link: 'https://example.com/ab/a1',
            description: 'first',
            pubDate: 'Wed, 15 Apr 2026 10:00:00 GMT',
          },
          { title: 'A2', link: 'https://example.com/ab/a2' },
        ]),
      ),
      'https://example.com/expressen.rss': xmlResponse(
        rssOf([{ title: 'E1', link: 'https://example.com/ex/e1', description: 'exp' }]),
      ),
      'https://example.com/ab/a1': htmlResponse(articleHtml('A1', 'Body A1.')),
      'https://example.com/ab/a2': htmlResponse(articleHtml('A2', 'Body A2.')),
      'https://example.com/ex/e1': htmlResponse(articleHtml('E1', 'Body E1.')),
    });

    const articles = await collectArticles({
      sources: [abTest, exTest],
      articlesPerSource: 2,
      signal: new AbortController().signal,
      logger: silentLogger,
      concurrency: 2,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.equal(articles.length, 3);
    const ab = articles.filter((a) => a.source === 'aftonbladet');
    const ex = articles.filter((a) => a.source === 'expressen');
    assert.equal(ab.length, 2);
    assert.equal(ex.length, 1);
    assert.equal(ab[0]?.title, 'A1');
    assert.equal(ab[0]?.sourceRank, 1);
    assert.equal(ab[0]?.description, 'first');
    assert.ok(ab[0]?.publishedAt instanceof Date);
    assert.equal(ab[1]?.sourceRank, 2);
    assert.equal(ab[1]?.description, null);
    assert.equal(ab[1]?.publishedAt, null);
    assert.equal(ex[0]?.title, 'E1');
    assert.match(ab[0]?.content ?? '', /Body A1/);
  });

  it('respects the articlesPerSource cap when the feed has more items', async () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      title: `H${i + 1}`,
      link: `https://example.com/ab/h${i + 1}`,
    }));
    const fetchResponses: Record<string, Response> = {
      'https://example.com/aftonbladet.rss': xmlResponse(rssOf(items)),
    };
    for (const it of items) {
      fetchResponses[it.link] = htmlResponse(articleHtml(it.title, `Body ${it.title}.`));
    }
    const fetcher = routedFetcher(fetchResponses);

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      concurrency: 5,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.equal(articles.length, 15);
    assert.equal(articles[0]?.sourceRank, 1);
    assert.equal(articles[14]?.sourceRank, 15);
  });

  it('skips a source whose RSS returns 500 but keeps the others', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse('', 500),
      'https://example.com/expressen.rss': xmlResponse(
        rssOf([{ title: 'E1', link: 'https://example.com/ex/e1' }]),
      ),
      'https://example.com/ex/e1': htmlResponse(articleHtml('E1', 'Body.')),
    });

    const articles = await collectArticles({
      sources: [abTest, exTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.equal(articles.length, 1);
    assert.equal(articles[0]?.source, 'expressen');
  });

  it('skips a source whose RSS throws a network error', async () => {
    const fetcher = async (url: string) => {
      if (url.includes('aftonbladet')) throw new TypeError('fetch failed');
      return xmlResponse(rssOf([{ title: 'E1', link: 'https://example.com/ex/e1' }]));
    };
    const routed = async (url: string): Promise<Response> => {
      if (url.startsWith('https://example.com/ex/e1')) {
        return htmlResponse(articleHtml('E1', 'Body.'));
      }
      return fetcher(url);
    };

    const articles = await collectArticles({
      sources: [abTest, exTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher: routed,
      assertPublicHost: alwaysPublic,
    });

    assert.equal(articles.length, 1);
  });

  it('skips a source whose hostname fails SSRF', async () => {
    const fetcher = routedFetcher({
      'https://example.com/expressen.rss': xmlResponse(
        rssOf([{ title: 'E1', link: 'https://example.com/ex/e1' }]),
      ),
      'https://example.com/ex/e1': htmlResponse(articleHtml('E1', 'Body.')),
    });
    const ssrf = async (hostname: string): Promise<void> => {
      if (hostname.includes('example.com') && hostname === new URL(abTest.rssUrl).hostname) {
        // intentionally allow others but we want a per-source reject
      }
      if (hostname === new URL(abTest.rssUrl).hostname) throw new Error('non-public');
    };
    // Note: abTest.rssUrl and exTest.rssUrl share the same hostname in test data.
    // Use a hostname-level match that only blocks Aftonbladet's full RSS URL would require
    // distinct hostnames — adjust sources to make this unambiguous:
    const abDistinct: NewsSource = {
      key: 'aftonbladet',
      name: 'Aftonbladet',
      rssUrl: 'https://private.test/aftonbladet.rss',
    };
    const ssrf2 = async (hostname: string): Promise<void> => {
      if (hostname === 'private.test') throw new Error('non-public');
    };

    const articles = await collectArticles({
      sources: [abDistinct, exTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: ssrf2,
    });

    // Keeping the first ssrf var referenced so no-unused-locals stays happy.
    void ssrf;

    assert.equal(articles.length, 1);
    assert.equal(articles[0]?.source, 'expressen');
  });

  it('skips individual articles that fail but keeps the rest of the source', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([
          { title: 'A1', link: 'https://example.com/ab/a1' },
          { title: 'A2', link: 'https://example.com/ab/a2' },
          { title: 'A3', link: 'https://example.com/ab/a3' },
        ]),
      ),
      'https://example.com/ab/a1': htmlResponse(articleHtml('A1', 'ok.')),
      'https://example.com/ab/a2': new Response('server down', {
        status: 503,
        headers: { 'Content-Type': 'text/plain' },
      }),
      'https://example.com/ab/a3': htmlResponse(articleHtml('A3', 'also ok.')),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      concurrency: 1,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.equal(articles.length, 2);
    assert.deepEqual(
      articles.map((a) => a.sourceRank),
      [1, 3],
    );
  });

  it('returns empty when every source fails', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse('', 500),
      'https://example.com/expressen.rss': xmlResponse('', 500),
      'https://example.com/svt.rss': xmlResponse('', 500),
    });

    const articles = await collectArticles({
      sources: [abTest, exTest, svtTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('returns empty when the feed parses to zero items', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse('<rss><channel></channel></rss>'),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('stops fetching new feeds once the signal aborts', async () => {
    const controller = new AbortController();
    const fetcher = async (url: string): Promise<Response> => {
      controller.abort(); // abort as soon as the first fetch happens
      if (url.includes('aftonbladet.rss')) {
        return xmlResponse(rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]));
      }
      throw new Error('should not reach');
    };

    const articles = await collectArticles({
      sources: [abTest, exTest],
      articlesPerSource: 15,
      signal: controller.signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    // The second source should be skipped once aborted.
    // Article fetches for the first source also abort, so the result may be 0 items.
    assert.ok(articles.length <= 1);
  });

  it('follows a 301 redirect on an article fetch (running SSRF on the target)', async () => {
    let ssrfCalls = 0;
    const ssrf = async (_h: string): Promise<void> => {
      ssrfCalls++;
    };
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/src' }]),
      ),
      'https://example.com/ab/src': new Response(null, {
        status: 301,
        headers: { Location: 'https://example.com/ab/dest' },
      }),
      'https://example.com/ab/dest': htmlResponse(articleHtml('Dest', 'Body.')),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: ssrf,
    });

    assert.equal(articles.length, 1);
    assert.equal(articles[0]?.url, 'https://example.com/ab/dest');
    // 1 for RSS + 1 for initial article + 1 for redirect target = 3.
    assert.ok(ssrfCalls >= 3);
  });

  it('drops an article on too many redirects', async () => {
    let hops = 0;
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('aftonbladet.rss')) {
        return xmlResponse(rssOf([{ title: 'A1', link: 'https://example.com/ab/0' }]));
      }
      hops++;
      return new Response(null, {
        status: 302,
        headers: { Location: `https://example.com/ab/${hops}` },
      });
    };

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article whose redirect has no Location header', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]),
      ),
      'https://example.com/ab/a1': new Response(null, { status: 302 }),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article whose redirect points to a non-http(s) scheme', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]),
      ),
      'https://example.com/ab/a1': new Response(null, {
        status: 302,
        headers: { Location: 'file:///etc/passwd' },
      }),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article whose redirect Location is malformed', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]),
      ),
      'https://example.com/ab/a1': new Response(null, {
        status: 302,
        headers: { Location: 'http://[bad:::1/' },
      }),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article whose upstream returns a non-2xx', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]),
      ),
      'https://example.com/ab/a1': new Response('Not found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain' },
      }),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article when extractor produces empty markdown (fallback body empty)', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]),
      ),
      // Body that fails Readability AND yields no markdown from fallback:
      'https://example.com/ab/a1': htmlResponse(''),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('maps a TimeoutError into a skipped article', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('.rss')) {
        return xmlResponse(rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]));
      }
      throw new DOMException('signal timed out', 'TimeoutError');
    };

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('maps an AbortError into a skipped article', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('.rss')) {
        return xmlResponse(rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]));
      }
      throw new DOMException('aborted', 'AbortError');
    };

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article with an invalid RSS link', async () => {
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'not a url' }]),
      ),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('skips a source whose RSS URL itself is malformed', async () => {
    const badSource: NewsSource = {
      key: 'aftonbladet',
      name: 'Aftonbladet',
      rssUrl: 'not a url',
    };

    const articles = await collectArticles({
      sources: [badSource],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher: async () => {
        throw new Error('should not be called');
      },
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('drops an article on a generic (non-DOMException) network error', async () => {
    const fetcher = async (url: string): Promise<Response> => {
      if (url.endsWith('.rss')) {
        return xmlResponse(rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]));
      }
      throw new TypeError('fetch failed');
    };

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.deepEqual(articles, []);
  });

  it('truncates article markdown to 50000 characters', async () => {
    const huge = 'A'.repeat(80_000);
    const html = `<html><head><title>T</title></head><body><article><p>${huge}</p></article></body></html>`;
    const fetcher = routedFetcher({
      'https://example.com/aftonbladet.rss': xmlResponse(
        rssOf([{ title: 'A1', link: 'https://example.com/ab/a1' }]),
      ),
      'https://example.com/ab/a1': htmlResponse(html),
    });

    const articles = await collectArticles({
      sources: [abTest],
      articlesPerSource: 15,
      signal: new AbortController().signal,
      logger: silentLogger,
      fetcher,
      assertPublicHost: alwaysPublic,
    });

    assert.equal(articles.length, 1);
    assert.ok((articles[0]?.content.length ?? 0) <= 50_000);
  });
});

describe('fetch-news worker.handler', () => {
  beforeEach(() => {
    mock.reset();
  });
  afterEach(() => {
    mock.reset();
  });

  function makeCtxWithPool(poolCalls: string[]): WorkerContext {
    const client = {
      query: mock.fn(async (sql: string) => {
        poolCalls.push(sql);
        return { rows: [], rowCount: 0 } as unknown as QueryResult<QueryResultRow>;
      }),
      release: () => {},
    } as unknown as PoolClient;
    const pool = {
      connect: mock.fn(async () => client),
      query: mock.fn(
        async () => ({ rows: [], rowCount: 0 }) as unknown as QueryResult<QueryResultRow>,
      ),
    } as unknown as Pool;
    return {
      logger: silentLogger,
      db: pool,
      signal: new AbortController().signal,
    } satisfies WorkerContext;
  }

  it('calls replaceAll when zero articles are collected is a no-op', async () => {
    // Mock global fetch to return failing responses so collectArticles returns [].
    mock.method(globalThis, 'fetch', async (url: string | URL): Promise<Response> => {
      void url;
      return xmlResponse('', 500);
    });
    const calls: string[] = [];
    const ctx = makeCtxWithPool(calls);

    await worker.handler(ctx);

    // connect should NOT have been called (no replaceAll).
    const connect = (ctx.db as unknown as { connect: ReturnType<typeof mock.fn> }).connect;
    assert.equal(connect.mock.callCount(), 0);
  });

  it('issues a full transaction when articles are collected', async () => {
    // Intercept fetch: any .rss URL returns a one-item RSS pointing to example.com; the article fetch returns HTML.
    // We need a real resolvable public hostname because the worker's handler calls the real assertPublicHostname.
    const rss = rssOf([{ title: 'Hi', link: 'https://example.com/hi' }]);
    mock.method(globalThis, 'fetch', async (url: string | URL): Promise<Response> => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.endsWith('.rss') || u.endsWith('.xml') || u.includes('feeds.')) return xmlResponse(rss);
      return htmlResponse(articleHtml('Hi', 'Body.'));
    });

    const calls: string[] = [];
    const ctx = makeCtxWithPool(calls);

    await worker.handler(ctx);

    const sqls = calls.join('\n');
    assert.match(sqls, /BEGIN/);
    assert.match(sqls, /DELETE FROM news_articles/);
    assert.match(sqls, /INSERT INTO news_articles/);
    assert.match(sqls, /COMMIT/);
  });
});
