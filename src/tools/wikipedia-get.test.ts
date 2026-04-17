import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './wikipedia-get.ts';

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

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const einsteinBody = {
  type: 'standard',
  title: 'Albert Einstein',
  displaytitle: '<b>Albert Einstein</b>',
  pageid: 736,
  description: 'German-born theoretical physicist (1879–1955)',
  extract: 'Albert Einstein was a German-born theoretical physicist...',
  extract_html: '<p><b>Albert Einstein</b> was...</p>',
  thumbnail: { source: 'https://upload.wikimedia.org/thumb/320px.jpg', width: 320, height: 410 },
  originalimage: { source: 'https://upload.wikimedia.org/original.jpg', width: 2523, height: 3229 },
  lang: 'en',
  content_urls: {
    desktop: { page: 'https://en.wikipedia.org/wiki/Albert_Einstein' },
    mobile: { page: 'https://en.m.wikipedia.org/wiki/Albert_Einstein' },
  },
  timestamp: '2026-04-10T14:22:31Z',
};

describe('wikipedia-get tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'wikipedia-get');
      assert.equal(tool.title, 'Wikipedia Get');
    });

    it('description mentions REST and disambiguation handling', () => {
      assert.match(tool.description, /REST/);
      assert.match(tool.description, /disambiguation/i);
    });

    it('has the documented rate limit', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 60 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a title alone with default language', () => {
      const r = schema.safeParse({ title: 'Albert Einstein' });
      assert.equal(r.success, true);
      if (r.success) assert.equal(r.data.language, 'en');
    });

    it('rejects an empty title', () => {
      assert.equal(schema.safeParse({ title: '' }).success, false);
    });

    it('rejects an invalid language code', () => {
      assert.equal(schema.safeParse({ title: 'x', language: '1a' }).success, false);
    });
  });

  describe('handler', () => {
    it('returns a standard-article snapshot on happy path', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(einsteinBody));
      const ctx = makeCtx();
      const result = await tool.handler({ title: 'Albert Einstein', language: 'en' }, ctx);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.title, 'Albert Einstein');
      assert.equal(structured.displaytitle, '<b>Albert Einstein</b>');
      assert.equal(structured.pageid, 736);
      assert.equal(structured.type, 'standard');
      assert.equal(structured.is_disambiguation, false);
      assert.equal(structured.url, 'https://en.wikipedia.org/wiki/Albert_Einstein');
      assert.equal(structured.mobile_url, 'https://en.m.wikipedia.org/wiki/Albert_Einstein');
      assert.equal(structured.thumbnail_url, 'https://upload.wikimedia.org/thumb/320px.jpg');
      assert.equal(structured.original_image_url, 'https://upload.wikimedia.org/original.jpg');
      assert.equal(structured.timestamp, '2026-04-10T14:22:31Z');
      assert.equal(structured.description, 'German-born theoretical physicist (1879–1955)');
    });

    it('URL-encodes the title in the request path', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(einsteinBody));
      const ctx = makeCtx();
      await tool.handler({ title: 'Piña colada & soda', language: 'en' }, ctx);

      assert.equal(fetchMock.mock.callCount(), 1);
      const urlArg = fetchMock.mock.calls[0]?.arguments[0] as string;
      // Spaces → '_'; accented letter and ampersand percent-encoded.
      assert.match(urlArg, /\/page\/summary\/Pi%C3%B1a_colada_%26_soda\?redirect=true$/);
    });

    it('flags disambiguation with is_disambiguation=true and includes a warning line', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          ...einsteinBody,
          type: 'disambiguation',
          title: 'Mercury',
          extract: 'Mercury may refer to...',
          content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Mercury' } },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ title: 'Mercury', language: 'en' }, ctx);

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.type, 'disambiguation');
      assert.equal(structured.is_disambiguation, true);
      assert.match(textOf(result), /disambiguation/i);
    });

    it('returns isError on HTTP 404', async () => {
      mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response('{"type":"https://mediawiki.org/wiki/HyperProblem","title":"Not found"}', {
            status: 404,
            headers: { 'Content-Type': 'application/problem+json' },
          }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ title: 'ZZZ_NonExistent', language: 'en' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /not found/i);
      assert.match(textOf(result), /wikipedia-search/);
    });

    it('throws TransientError on HTTP 5xx', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('oops', { status: 502 }));
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ title: 'Anything', language: 'en' }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /HTTP 502/);
          return true;
        },
      );
    });

    it('throws TransientError when fetch rejects (network error)', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ title: 'x', language: 'en' }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('falls back to a constructed URL when content_urls is missing', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          type: 'standard',
          title: 'Foo Bar',
          pageid: 1,
          extract: 'hi',
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ title: 'Foo Bar', language: 'en' }, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.url, 'https://en.wikipedia.org/wiki/Foo_Bar');
      assert.equal(structured.mobile_url, null);
      assert.equal(structured.thumbnail_url, null);
    });

    it('normalizes an unknown type string to "standard"', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({ type: 'something-weird', title: 'X', pageid: 1, extract: '' }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ title: 'X', language: 'en' }, ctx);
      const structured = result.structuredContent as Record<string, unknown>;
      assert.equal(structured.type, 'standard');
    });

    it('structuredContent validates against the declared outputSchema', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(einsteinBody));
      const ctx = makeCtx();
      const result = await tool.handler({ title: 'Albert Einstein', language: 'en' }, ctx);
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('passes User-Agent header', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(einsteinBody));
      const ctx = makeCtx();
      await tool.handler({ title: 'Einstein', language: 'en' }, ctx);
      const init = fetchMock.mock.calls[0]?.arguments[1] as { headers: Record<string, string> };
      assert.equal(init.headers['User-Agent'], USER_AGENT);
    });
  });
});
