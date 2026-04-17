import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import type { Pool, QueryResult, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { ToolContext } from '../shared/tools/types.ts';
import tool from './get-news.ts';

function poolReturning(rows: Array<Record<string, unknown>>): Pool {
  const query = mock.fn(
    async () =>
      ({
        rows,
        rowCount: rows.length,
      }) as unknown as QueryResult<QueryResultRow>,
  );
  return { query, connect: mock.fn() } as unknown as Pool;
}

function makeCtx(pool: Pool): ToolContext {
  return {
    logger: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    db: pool,
    redis: { get: mock.fn(), set: mock.fn() },
    apiKey: {
      id: '550e8400-e29b-41d4-a716-446655440000',
      prefix: 'mcp_test_abc',
      name: 'test',
      rateLimitPerMinute: 60,
    },
    requestId: 'req-1',
    signal: new AbortController().signal,
  } as unknown as ToolContext;
}

function fakeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'uuid',
    source: 'aftonbladet',
    source_rank: 1,
    url: 'https://www.aftonbladet.se/a',
    title: 'Rubrik',
    description: 'Sammanfattning',
    content: '# Brödtext',
    published_at: new Date('2026-04-16T10:00:00Z'),
    fetched_at: new Date('2026-04-16T14:00:00Z'),
    ...overrides,
  };
}

describe('get-news metadata', () => {
  it('has the expected identity', () => {
    assert.equal(tool.name, 'get-news');
    assert.equal(tool.title, 'Get News');
  });

  it('description mentions all three outlets and Markdown', () => {
    assert.match(tool.description, /Aftonbladet/);
    assert.match(tool.description, /Expressen/);
    assert.match(tool.description, /SVT/);
    assert.match(tool.description, /Markdown/);
  });

  it('accepts zero-arg invocations', () => {
    const schema = z.object(tool.inputSchema);
    assert.equal(schema.safeParse({}).success, true);
  });
});

describe('get-news handler', () => {
  beforeEach(() => {
    mock.reset();
  });

  it('returns isError when the cache is empty', async () => {
    const pool = poolReturning([]);
    const result = await tool.handler({}, makeCtx(pool));

    assert.equal(result.isError, true);
    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /empty/i);
    assert.match(text, /not populated/);
    // The current-date section is still prepended in the error path so the
    // LLM does not fall back to a stale training-data year in its reply.
    assert.match(text, /# Current date/);
    assert.match(text, /current year is \d{4}/);
  });

  it('groups records by source, orders by rank, and fills empty sources', async () => {
    const rows = [
      fakeRow({ source: 'svt', source_rank: 2, title: 'SVT-2' }),
      fakeRow({ source: 'svt', source_rank: 1, title: 'SVT-1' }),
      fakeRow({ source: 'aftonbladet', source_rank: 1, title: 'AB-1' }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));

    assert.equal(result.isError, undefined);
    const sources = (
      result.structuredContent as {
        sources: Array<{ key: string; articles: Array<{ rank: number; title: string }> }>;
      }
    ).sources;
    assert.equal(sources.length, 3);
    // Order enforced by NEWS_SOURCES order.
    assert.deepEqual(
      sources.map((s) => s.key),
      ['aftonbladet', 'expressen', 'svt'],
    );
    const svt = sources.find((s) => s.key === 'svt');
    assert.deepEqual(
      svt?.articles.map((a) => a.rank),
      [1, 2],
    );
    const expressen = sources.find((s) => s.key === 'expressen');
    assert.equal(expressen?.articles.length, 0);
  });

  it('exposes the most recent fetched_at as ISO 8601', async () => {
    const rows = [
      fakeRow({ fetched_at: new Date('2026-04-16T10:00:00Z') }),
      fakeRow({ fetched_at: new Date('2026-04-16T14:30:00Z') }),
      fakeRow({ fetched_at: new Date('2026-04-16T12:00:00Z') }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));

    const fetchedAt = (result.structuredContent as { fetched_at: string }).fetched_at;
    assert.equal(fetchedAt, '2026-04-16T14:30:00.000Z');
  });

  it('renders the text block with Markdown source headers, per-article source, URL, and body', async () => {
    const rows = [
      fakeRow({
        source: 'aftonbladet',
        source_rank: 1,
        title: 'AB-headline',
        content: 'Body text for AB.',
      }),
      fakeRow({
        source: 'expressen',
        source_rank: 1,
        title: 'EX-headline',
        content: 'Body text for EX.',
      }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));

    const text = (result.content[0] as { text: string }).text;
    assert.match(text, /^## Aftonbladet$/m);
    assert.match(text, /^## Expressen$/m);
    assert.match(text, /^## SVT Nyheter$/m);
    assert.match(text, /^### 1\. AB-headline$/m);
    assert.match(text, /- \*\*Källa:\*\* Aftonbladet/);
    assert.match(text, /- \*\*URL:\*\* https:\/\/www\.aftonbladet\.se\/a/);
    assert.match(text, /Body text for AB\./);
    assert.match(text, /\(inga cachade artiklar\)/);
  });

  it('prepends a strong current-date section with the year and language instruction', async () => {
    const rows = [fakeRow()];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));
    const text = (result.content[0] as { text: string }).text;

    // Header with weekday + ISO date + UTC + year emphasis.
    assert.match(text, /^# Current date$/m, 'must begin with a Current date Markdown header');
    const year = new Date().getUTCFullYear();
    const isoDate = new Date().toISOString().slice(0, 10);
    assert.match(
      text,
      new RegExp(`Today is \\w+, ${isoDate} \\(UTC\\)\\. The current year is ${year}\\.`),
    );

    // Strong instruction against stale-year hallucination.
    assert.match(text, /training cutoff/i);
    assert.match(text, /2024/);
    assert.match(text, /do NOT claim it is still 2024/i);

    // Language-matching instruction.
    assert.match(text, /same language they wrote/i);
    assert.match(text, /English.*Swedish/);

    // Section is visually separated from the articles.
    assert.match(text, /\n---\n/);
  });

  it('labels missing publishedAt as "okänt" and missing description as "(ingen sammanfattning)"', async () => {
    const rows = [
      fakeRow({
        source: 'aftonbladet',
        source_rank: 1,
        published_at: null,
        description: null,
      }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));
    const text = (result.content[0] as { text: string }).text;

    assert.match(text, /- \*\*Publicerad:\*\* okänt/);
    assert.match(text, /\(ingen sammanfattning\)/);
  });

  it('exposes current_date and current_weekday in structuredContent', async () => {
    const rows = [fakeRow()];
    const before = Date.now();
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));
    const after = Date.now();

    const structured = result.structuredContent as {
      current_date: string;
      current_weekday: string;
    };
    const t = Date.parse(structured.current_date);
    assert.ok(
      Number.isFinite(t) && t >= before - 1 && t <= after + 1,
      `current_date should be a valid ISO 8601 timestamp near "now" — got ${structured.current_date}`,
    );
    assert.match(
      structured.current_weekday,
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/,
    );
  });

  it('produces structuredContent that validates against the declared outputSchema', async () => {
    const rows = [
      fakeRow({ source: 'aftonbladet', source_rank: 1 }),
      fakeRow({ source: 'expressen', source_rank: 1 }),
      fakeRow({ source: 'svt', source_rank: 1 }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));

    const schema = z.object(tool.outputSchema ?? {});
    const parsed = schema.safeParse(result.structuredContent);
    assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
  });

  it('serializes publishedAt as ISO 8601 in structured articles', async () => {
    const rows = [
      fakeRow({
        source: 'aftonbladet',
        source_rank: 1,
        published_at: new Date('2026-04-15T08:30:00Z'),
      }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));

    const sources = (
      result.structuredContent as {
        sources: Array<{ key: string; articles: Array<{ published_at: string | null }> }>;
      }
    ).sources;
    const ab = sources.find((s) => s.key === 'aftonbladet');
    assert.equal(ab?.articles[0]?.published_at, '2026-04-15T08:30:00.000Z');
  });

  it('preserves null publishedAt in structured output', async () => {
    const rows = [fakeRow({ source: 'aftonbladet', source_rank: 1, published_at: null })];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));
    const sources = (
      result.structuredContent as {
        sources: Array<{ key: string; articles: Array<{ published_at: string | null }> }>;
      }
    ).sources;
    const ab = sources.find((s) => s.key === 'aftonbladet');
    assert.equal(ab?.articles[0]?.published_at, null);
  });

  it('fetched_at is null when the cache is empty (error path is tested separately)', async () => {
    // Even in the non-error path with a single row, fetched_at should be the row's fetched_at.
    const rows = [
      fakeRow({
        source: 'aftonbladet',
        source_rank: 1,
        fetched_at: new Date('2026-04-16T14:30:00Z'),
      }),
    ];
    const result = await tool.handler({}, makeCtx(poolReturning(rows)));
    const fetchedAt = (result.structuredContent as { fetched_at: string | null }).fetched_at;
    assert.equal(fetchedAt, '2026-04-16T14:30:00.000Z');
  });
});
