import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './web-search.ts';

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
    signal: AbortSignal.timeout(5000),
    ...overrides,
  }) as unknown as ToolContext;

const makeSearxngResponse = (
  results: Array<{ title: string; url: string; content?: string; engine?: string }>,
) => ({
  results,
  query: 'test',
  number_of_results: results.length,
});

const sampleResults = [
  { title: 'Result One', url: 'https://example.com/1', content: 'First snippet', engine: 'google' },
  { title: 'Result Two', url: 'https://example.com/2', content: 'Second snippet', engine: 'brave' },
  { title: 'Result Three', url: 'https://example.com/3', content: 'Third snippet', engine: 'bing' },
];

describe('web-search tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'web-search');
      assert.equal(tool.title, 'Web Search');
    });

    it('has a non-empty description', () => {
      assert.ok(tool.description.length > 0);
    });

    it('has rate limit set', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 30 });
    });

    it('declares a compiling outputSchema', () => {
      assert.ok(tool.outputSchema, 'expected outputSchema');
      const schema = z.object(tool.outputSchema);
      const parsed = schema.safeParse({
        query: 'stockholm',
        results: [
          { rank: 1, title: 't', url: 'https://example.com', snippet: 's', source: 'google' },
        ],
      });
      assert.equal(parsed.success, true);
    });
  });

  describe('handler', () => {
    it('returns formatted results for a valid query', async () => {
      mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify(makeSearxngResponse(sampleResults)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'test search', language: 'sv', limit: 10, categories: 'general' },
        ctx,
      );

      assert.equal(result.isError, undefined);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      assert.match(text, /Web search results for "test search"/);
      assert.match(text, /Result One/);
      assert.ok(text.includes('https://example.com/1'), 'expected first result URL');
      assert.match(text, /Result Two/);
      assert.match(text, /Result Three/);
      assert.match(text, /Source: google/);

      // structuredContent mirrors the content[] text for clients that consume typed data.
      assert.ok(result.structuredContent, 'expected structuredContent');
      assert.equal(result.structuredContent?.query, 'test search');
      const structuredResults = result.structuredContent?.results as Array<{
        rank: number;
        title: string;
        url: string;
        snippet: string;
        source: string;
      }>;
      assert.equal(structuredResults.length, 3);
      assert.deepEqual(structuredResults[0], {
        rank: 1,
        title: 'Result One',
        url: 'https://example.com/1',
        snippet: 'First snippet',
        source: 'google',
      });
    });

    it('respects the limit parameter', async () => {
      const manyResults = Array.from({ length: 10 }, (_, i) => ({
        title: `Result ${i + 1}`,
        url: `https://example.com/${i + 1}`,
        content: `Snippet ${i + 1}`,
        engine: 'google',
      }));

      mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify(makeSearxngResponse(manyResults)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'test', language: 'sv', limit: 3, categories: 'general' },
        ctx,
      );

      const text = (result.content[0] as { type: 'text'; text: string }).text;
      assert.match(text, /1\. Result 1/);
      assert.match(text, /3\. Result 3/);
      assert.doesNotMatch(text, /4\. Result 4/);
    });

    it('passes correct query parameters to SearXNG', async () => {
      const fetchMock = mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify(makeSearxngResponse(sampleResults)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const ctx = makeCtx();
      await tool.handler(
        { query: 'stockholm weather', language: 'sv', limit: 10, categories: 'general' },
        ctx,
      );

      assert.equal(fetchMock.mock.callCount(), 1);
      const calledUrl = new URL(fetchMock.mock.calls[0].arguments[0] as string);
      assert.equal(calledUrl.pathname, '/search');
      assert.equal(calledUrl.searchParams.get('q'), 'stockholm weather');
      assert.equal(calledUrl.searchParams.get('format'), 'json');
      assert.equal(calledUrl.searchParams.get('language'), 'sv');
      assert.equal(calledUrl.searchParams.get('engines'), 'google,brave,bing,qwant,startpage');
      assert.equal(calledUrl.searchParams.get('categories'), 'general');
    });

    it('uses custom language when provided', async () => {
      const fetchMock = mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify(makeSearxngResponse(sampleResults)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const ctx = makeCtx();
      await tool.handler({ query: 'test', language: 'en', limit: 10, categories: 'general' }, ctx);

      const calledUrl = new URL(fetchMock.mock.calls[0].arguments[0] as string);
      assert.equal(calledUrl.searchParams.get('language'), 'en');
    });

    it('uses custom categories when provided', async () => {
      const fetchMock = mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify(makeSearxngResponse(sampleResults)), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const ctx = makeCtx();
      await tool.handler({ query: 'test', language: 'sv', limit: 10, categories: 'news' }, ctx);

      const calledUrl = new URL(fetchMock.mock.calls[0].arguments[0] as string);
      assert.equal(calledUrl.searchParams.get('categories'), 'news');
    });

    it('handles results with missing content gracefully', async () => {
      mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            JSON.stringify(
              makeSearxngResponse([{ title: 'No Snippet', url: 'https://example.com/no-snippet' }]),
            ),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          ),
      );

      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'test', language: 'sv', limit: 10, categories: 'general' },
        ctx,
      );

      const text = (result.content[0] as { type: 'text'; text: string }).text;
      assert.match(text, /\(no snippet\)/);
      assert.match(text, /Source: unknown/);
    });

    it('returns isError when SearXNG returns no results', async () => {
      mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(JSON.stringify(makeSearxngResponse([])), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      );

      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'xyznonexistent', language: 'sv', limit: 10, categories: 'general' },
        ctx,
      );

      assert.equal(result.isError, true);
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      assert.match(text, /No results found for "xyznonexistent"/);
      assert.deepEqual(result.structuredContent, { query: 'xyznonexistent', results: [] });
    });

    it('throws TransientError when fetch fails with network error', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new TypeError('fetch failed');
      });

      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler({ query: 'test', language: 'sv', limit: 10, categories: 'general' }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /SearXNG request failed/);
          return true;
        },
      );
    });

    it('throws TransientError when SearXNG returns non-200', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('error', { status: 503 }));

      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler({ query: 'test', language: 'sv', limit: 10, categories: 'general' }, ctx),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /SearXNG returned HTTP 503/);
          return true;
        },
      );
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a valid query with defaults', () => {
      const result = schema.safeParse({ query: 'test query' });
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.language, 'sv');
        assert.equal(result.data.limit, 10);
        assert.equal(result.data.categories, 'general');
      }
    });

    it('accepts all fields explicitly set', () => {
      const result = schema.safeParse({
        query: 'test',
        language: 'en',
        limit: 20,
        categories: 'news',
      });
      assert.equal(result.success, true);
    });

    it('rejects empty query', () => {
      const result = schema.safeParse({ query: '' });
      assert.equal(result.success, false);
    });

    it('rejects query exceeding max length', () => {
      const result = schema.safeParse({ query: 'a'.repeat(401) });
      assert.equal(result.success, false);
    });

    it('rejects missing query', () => {
      const result = schema.safeParse({});
      assert.equal(result.success, false);
    });

    it('rejects limit of 0', () => {
      const result = schema.safeParse({ query: 'test', limit: 0 });
      assert.equal(result.success, false);
    });

    it('rejects limit exceeding max', () => {
      const result = schema.safeParse({ query: 'test', limit: 31 });
      assert.equal(result.success, false);
    });

    it('rejects non-integer limit', () => {
      const result = schema.safeParse({ query: 'test', limit: 5.5 });
      assert.equal(result.success, false);
    });

    it('rejects language shorter than 2 chars', () => {
      const result = schema.safeParse({ query: 'test', language: 'x' });
      assert.equal(result.success, false);
    });

    it('rejects language longer than 5 chars', () => {
      const result = schema.safeParse({ query: 'test', language: 'toolong' });
      assert.equal(result.success, false);
    });

    it('rejects empty categories', () => {
      const result = schema.safeParse({ query: 'test', categories: '' });
      assert.equal(result.success, false);
    });
  });
});
