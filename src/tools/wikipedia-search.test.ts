import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { articleUrl, stripSnippetHtml } from './wikipedia-search.ts';

const makeCtx = (overrides: Record<string, unknown> = {}): ToolContext =>
  ({
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: { query: mock.fn(async () => ({ rows: [] })) },
    redis: { get: mock.fn(), set: mock.fn() },
    apiKey: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      prefix: 'mcp_test_abc',
      name: 'test key',
      rateLimitPerMinute: 60,
    },
    requestId: 'req-00000000-0000-0000-0000-000000000001',
    signal: new AbortController().signal,
    ...overrides,
  }) as unknown as ToolContext;

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });

const fixtureBody = {
  batchcomplete: true,
  continue: { sroffset: 3 },
  query: {
    searchinfo: { totalhits: 12345 },
    search: [
      {
        ns: 0,
        title: 'Albert Einstein',
        pageid: 736,
        size: 148392,
        wordcount: 18742,
        snippet:
          '<span class="searchmatch">Albert</span> <span class="searchmatch">Einstein</span> was a German-born &amp; theoretical physicist',
        timestamp: '2026-04-10T14:22:31Z',
      },
      {
        ns: 0,
        title: 'Hans Albert Einstein',
        pageid: 1000,
        size: 1000,
        wordcount: 500,
        snippet: 'Son of <span class="searchmatch">Albert</span> &nbsp;&#8211; engineer',
        timestamp: '2026-02-01T00:00:00Z',
      },
    ],
  },
};

describe('wikipedia-search helpers', () => {
  it('stripSnippetHtml returns an empty string for empty input', () => {
    assert.equal(stripSnippetHtml(''), '');
  });

  it('stripSnippetHtml decodes numeric + hex + named entities', () => {
    assert.equal(stripSnippetHtml('a &amp; b'), 'a & b');
    assert.equal(stripSnippetHtml('&lt;x&gt; &quot;q&quot; &#39;o&#39;'), '<x> "q" \'o\'');
    assert.equal(stripSnippetHtml('&#65; &#x41;'), 'A A');
  });

  it('articleUrl percent-encodes unicode and preserves slashes', () => {
    assert.equal(articleUrl('en', 'foo bar'), 'https://en.wikipedia.org/wiki/foo_bar');
    assert.equal(
      articleUrl('sv', 'Göteborg'),
      `https://sv.wikipedia.org/wiki/${encodeURI('Göteborg')}`,
    );
  });
});

describe('wikipedia-search tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'wikipedia-search');
      assert.equal(tool.title, 'Wikipedia Search');
    });

    it('description mentions MediaWiki, snippets, and CirrusSearch operators', () => {
      assert.match(tool.description, /MediaWiki/);
      assert.match(tool.description, /snippet/i);
      assert.match(tool.description, /CirrusSearch/i);
    });

    it('has the documented rate limit', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 60 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a minimal valid query with defaults', () => {
      const r = schema.safeParse({ query: 'einstein' });
      assert.equal(r.success, true);
      if (r.success) {
        assert.equal(r.data.limit, 10);
        assert.equal(r.data.language, 'en');
        assert.equal(r.data.offset, 0);
      }
    });

    it('rejects an empty query', () => {
      assert.equal(schema.safeParse({ query: '' }).success, false);
    });

    it('rejects a query longer than 500 chars', () => {
      assert.equal(schema.safeParse({ query: 'a'.repeat(501) }).success, false);
    });

    it('rejects a single-letter language', () => {
      assert.equal(schema.safeParse({ query: 'x', language: 'e' }).success, false);
    });

    it('rejects uppercase language codes', () => {
      assert.equal(schema.safeParse({ query: 'x', language: 'EN' }).success, false);
    });

    it('accepts hyphenated language (e.g. zh-hans)', () => {
      assert.equal(schema.safeParse({ query: 'x', language: 'zh-hans' }).success, true);
    });

    it('rejects limit=0 and limit>50', () => {
      assert.equal(schema.safeParse({ query: 'x', limit: 0 }).success, false);
      assert.equal(schema.safeParse({ query: 'x', limit: 51 }).success, false);
    });

    it('rejects offset > 9000', () => {
      assert.equal(schema.safeParse({ query: 'x', offset: 9001 }).success, false);
    });
  });

  describe('handler', () => {
    it('returns cleaned snippets, page URLs, and next_offset on happy path', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(fixtureBody));
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'Einstein', limit: 10, language: 'en', offset: 0 },
        ctx,
      );

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.language, 'en');
      assert.equal(structured.query, 'Einstein');
      assert.equal(structured.total_hits, 12345);
      assert.equal(structured.offset, 0);
      assert.equal(structured.next_offset, 3);
      assert.equal(structured.suggestion, null);

      const results = structured.results as Array<Record<string, unknown>>;
      assert.equal(results.length, 2);
      assert.equal(results[0]?.title, 'Albert Einstein');
      assert.equal(results[0]?.pageid, 736);
      assert.equal(results[0]?.url, 'https://en.wikipedia.org/wiki/Albert_Einstein');
      // Snippet cleaned: span stripped, entities decoded, whitespace collapsed
      assert.equal(
        results[0]?.snippet_clean,
        'Albert Einstein was a German-born & theoretical physicist',
      );
      assert.match(results[0]?.snippet_html as string, /<span class="searchmatch">/);
      assert.equal(results[0]?.timestamp, '2026-04-10T14:22:31Z');
      assert.equal(results[1]?.snippet_clean, 'Son of Albert – engineer');
    });

    it('constructs URLs with underscore-encoded spaces and percent-encoding', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: {
            searchinfo: { totalhits: 1 },
            search: [
              {
                ns: 0,
                title: 'Göteborg/Stadshus (building)',
                pageid: 42,
                size: 1,
                wordcount: 1,
                snippet: '',
                timestamp: '2026-01-01T00:00:00Z',
              },
            ],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'Goteborg', limit: 1, language: 'sv', offset: 0 },
        ctx,
      );
      const structured = result.structuredContent as Record<string, unknown>;
      const results = structured.results as Array<Record<string, unknown>>;
      assert.equal(
        results[0]?.url,
        `https://sv.wikipedia.org/wiki/${encodeURI('Göteborg/Stadshus_(building)')}`,
      );
    });

    it('sends the expected query parameters and User-Agent header', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(fixtureBody));
      const ctx = makeCtx();
      await tool.handler({ query: 'special:chars?', limit: 5, language: 'sv', offset: 20 }, ctx);

      assert.equal(fetchMock.mock.callCount(), 1);
      const [urlArg, initArg] = fetchMock.mock.calls[0]?.arguments ?? [];
      const url = new URL(urlArg as string);
      assert.equal(url.hostname, 'sv.wikipedia.org');
      assert.equal(url.pathname, '/w/api.php');
      assert.equal(url.searchParams.get('action'), 'query');
      assert.equal(url.searchParams.get('list'), 'search');
      assert.equal(url.searchParams.get('formatversion'), '2');
      assert.equal(url.searchParams.get('srsearch'), 'special:chars?');
      assert.equal(url.searchParams.get('srlimit'), '5');
      assert.equal(url.searchParams.get('sroffset'), '20');

      const init = initArg as { headers: Record<string, string> };
      assert.equal(init.headers['User-Agent'], USER_AGENT);
    });

    it('returns isError when the search has zero hits (and carries the suggestion)', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: { searchinfo: { totalhits: 0, suggestion: 'einstien' }, search: [] },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'einstein', limit: 10, language: 'en', offset: 0 },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result), /No Wikipedia results for "einstein"/);
      assert.match(textOf(result), /Did you mean "einstien"/);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.suggestion, 'einstien');
      assert.deepEqual(structured.results, []);
    });

    it('exposes next_offset=null when upstream omits continue', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: {
            searchinfo: { totalhits: 1 },
            search: [
              {
                ns: 0,
                title: 'Only Hit',
                pageid: 1,
                size: 1,
                wordcount: 1,
                snippet: 'hello',
                timestamp: '2026-01-01T00:00:00Z',
              },
            ],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ query: 'x', limit: 10, language: 'en', offset: 0 }, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.next_offset, null);
    });

    it('throws TransientError when fetch rejects', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ query: 'x', limit: 10, language: 'en', offset: 0 }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /Wikipedia search request failed/);
          return true;
        },
      );
    });

    it('throws TransientError on HTTP 5xx', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('error', { status: 503 }));
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ query: 'x', limit: 10, language: 'en', offset: 0 }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /HTTP 503/);
          return true;
        },
      );
    });

    it('renders a text block with rank, URL, and snippet lines', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(fixtureBody));
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'Einstein', limit: 10, language: 'en', offset: 0 },
        ctx,
      );
      const text = textOf(result);
      assert.match(text, /12,345 total hits/);
      assert.match(text, /^1\. Albert Einstein/m);
      assert.match(text, /URL: https:\/\/en\.wikipedia\.org\/wiki\/Albert_Einstein/);
      assert.match(text, /More results available — pass offset=3/);
    });

    it('fills wordcount=0 and timestamp=null when upstream omits them', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: {
            searchinfo: { totalhits: 1 },
            search: [{ ns: 0, title: 'Barebones', pageid: 42 }],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'Barebones', limit: 10, language: 'en', offset: 0 },
        ctx,
      );
      const structured = result.structuredContent as Record<string, unknown>;
      const results = structured.results as Array<Record<string, unknown>>;
      assert.equal(results[0]?.wordcount, 0);
      assert.equal(results[0]?.timestamp, null);
      assert.equal(results[0]?.snippet_clean, '');
    });

    it('omits the "more results available" line when next_offset is null', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: {
            searchinfo: { totalhits: 1 },
            search: [
              {
                ns: 0,
                title: 'Only',
                pageid: 1,
                size: 1,
                wordcount: 1,
                snippet: 'x',
                timestamp: '2026-01-01T00:00:00Z',
              },
            ],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ query: 'x', limit: 10, language: 'en', offset: 0 }, ctx);
      const text = (result.content[0] as { text: string }).text;
      assert.doesNotMatch(text, /More results available/);
    });

    it('omits the last-edited clause when timestamp is null in the text block', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: {
            searchinfo: { totalhits: 1 },
            search: [{ ns: 0, title: 'NoTs', pageid: 2, size: 1, wordcount: 1, snippet: '' }],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ query: 'x', limit: 10, language: 'en', offset: 0 }, ctx);
      const text = (result.content[0] as { text: string }).text;
      assert.match(text, /1\. NoTs$/m);
      assert.doesNotMatch(text, /last edited/);
      assert.match(text, /\(no snippet\)/);
    });

    it('uses "0 total hits" when searchinfo is missing and search is non-empty', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          query: {
            search: [{ ns: 0, title: 'A', pageid: 1, size: 1, wordcount: 1, snippet: '' }],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ query: 'x', limit: 10, language: 'en', offset: 0 }, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.total_hits, 0);
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(fixtureBody));
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'Einstein', limit: 10, language: 'en', offset: 0 },
        ctx,
      );
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });
  });
});
