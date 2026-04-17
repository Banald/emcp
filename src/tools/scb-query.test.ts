import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, {
  type DataSnapshot,
  formatDataText,
  formatMetadataText,
  type MetadataSnapshot,
  normalizeColumns,
  normalizeRows,
  normalizeVariables,
} from './scb-query.ts';

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

const METADATA_BODY = {
  title: 'Population by region, marital status, age, sex, observations and year',
  variables: [
    {
      code: 'Region',
      text: 'region',
      values: ['00', '01', '0114'],
      valueTexts: ['Sweden', 'Stockholm County', 'Upplands Väsby'],
      elimination: true,
    },
    {
      code: 'Kon',
      text: 'sex',
      values: ['1', '2'],
      valueTexts: ['men', 'women'],
      elimination: true,
    },
    {
      code: 'ContentsCode',
      text: 'observations',
      values: ['BE0101N1'],
      valueTexts: ['Population'],
    },
    {
      code: 'Tid',
      text: 'year',
      values: ['2023', '2024'],
      valueTexts: ['2023', '2024'],
      time: true,
    },
  ],
};

const DATA_BODY = {
  columns: [
    { code: 'Region', text: 'region', type: 'd' },
    { code: 'Kon', text: 'sex', type: 'd' },
    { code: 'Tid', text: 'year', type: 't' },
    { code: 'BE0101N1', text: 'Population', type: 'c', unit: 'number' },
  ],
  comments: [],
  data: [
    { key: ['00', '1', '2023'], values: ['5238760'] },
    { key: ['00', '2', '2023'], values: ['5311107'] },
  ],
};

describe('scb-query normalization', () => {
  it('normalizeVariables returns [] when upstream omits variables', () => {
    assert.deepEqual(normalizeVariables({}), []);
  });

  it('normalizeVariables defaults every field from a bare object', () => {
    const vars = normalizeVariables({ variables: [{}] });
    assert.equal(vars.length, 1);
    assert.equal(vars[0]?.code, '');
    assert.equal(vars[0]?.text, '');
    assert.deepEqual(vars[0]?.values, []);
    assert.deepEqual(vars[0]?.value_texts, []);
    assert.equal(vars[0]?.elimination, false);
    assert.equal(vars[0]?.time, false);
  });

  it('normalizeColumns returns [] when upstream omits columns', () => {
    assert.deepEqual(normalizeColumns({}), []);
  });

  it('normalizeColumns defaults every field from a bare object', () => {
    const cols = normalizeColumns({ columns: [{}] });
    assert.equal(cols.length, 1);
    assert.equal(cols[0]?.code, '');
    assert.equal(cols[0]?.text, '');
    assert.equal(cols[0]?.type, '');
    assert.equal(cols[0]?.unit, null);
  });

  it('normalizeRows returns [] when upstream omits data', () => {
    assert.deepEqual(normalizeRows({}), []);
  });

  it('normalizeRows returns copies of key / values arrays', () => {
    const rows = normalizeRows({
      data: [{ key: ['a', 'b'], values: ['1', '2'] }, {}],
    });
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0]?.key, ['a', 'b']);
    assert.deepEqual(rows[0]?.values, ['1', '2']);
    assert.deepEqual(rows[1]?.key, []);
    assert.deepEqual(rows[1]?.values, []);
  });
});

describe('scb-query helpers', () => {
  it('formatMetadataText handles empty title and zero-value variables', () => {
    const snapshot: MetadataSnapshot = {
      mode: 'metadata',
      path: 'BE/BE0101',
      language: 'en',
      title: null,
      variables: [],
    };
    const text = formatMetadataText(snapshot);
    assert.match(text, /^SCB metadata — BE\/BE0101 \(en\)$/m);
    assert.doesNotMatch(text, /^Title:/m);
  });

  it('formatMetadataText flags time / elimination variables and samples 5 values max', () => {
    const snapshot: MetadataSnapshot = {
      mode: 'metadata',
      path: 'p',
      language: 'sv',
      title: 'The table',
      variables: [
        {
          code: 'Tid',
          text: 'year',
          values: ['2019', '2020', '2021', '2022', '2023', '2024', '2025'],
          value_texts: ['2019', '2020', '2021', '2022', '2023', '2024', '2025'],
          elimination: false,
          time: true,
        },
        {
          code: 'Region',
          text: 'region',
          values: ['00', '01'],
          value_texts: [], // no valueTexts — fallback to code
          elimination: true,
          time: false,
        },
      ],
    };
    const text = formatMetadataText(snapshot);
    assert.match(text, /^Title: The table$/m);
    assert.match(text, /• Tid \(year\) \[time\]/);
    assert.match(text, /• Region \(region\) \[eliminable\]/);
    // Only the first 5 values appear in the sample
    assert.match(text, /first 5: 2019="2019", 2020="2020", 2021="2021", 2022="2022", 2023="2023"/);
    assert.doesNotMatch(text, /"2024"/);
    // Fallback to code when value_texts is missing
    assert.match(text, /00="00", 01="01"/);
  });

  it('formatDataText handles zero columns and zero rows', () => {
    const snapshot: DataSnapshot = {
      mode: 'data',
      path: 'p',
      language: 'en',
      columns: [],
      rows: [],
      raw_format: 'json',
    };
    const text = formatDataText(snapshot);
    assert.match(text, /Columns: \(none\)/);
    assert.match(text, /Rows: 0/);
  });

  it('formatDataText truncates >10 rows and prints the tail marker', () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({
      key: [String(i)],
      values: [String(i * 2)],
    }));
    const snapshot: DataSnapshot = {
      mode: 'data',
      path: 'p',
      language: 'en',
      columns: [{ code: 'X', text: 'X', type: 'c', unit: null }],
      rows,
      raw_format: 'json',
    };
    const text = formatDataText(snapshot);
    assert.match(text, /Rows: 13/);
    assert.match(text, /\[0\] → 0/);
    assert.match(text, /\[9\] → 18/);
    assert.match(text, /… \(3 more rows\)/);
    assert.doesNotMatch(text, /\[10\] → 20/);
  });
});

describe('scb-query tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'scb-query');
      assert.equal(tool.title, 'SCB PxWeb Query');
    });

    it('description mentions metadata and data modes', () => {
      assert.match(tool.description, /metadata/);
      assert.match(tool.description, /data/);
      assert.match(tool.description, /PxWeb/);
    });

    it('has rate limit 30/min', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 30 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a valid path with defaults', () => {
      const r = schema.safeParse({ path: 'BE/BE0101/BE0101A/BefolkningNy' });
      assert.equal(r.success, true);
      if (r.success) {
        assert.equal(r.data.language, 'en');
        assert.equal(r.data.mode, 'metadata');
        assert.equal(r.data.format, 'json');
      }
    });

    it('rejects a path containing ".."', () => {
      const r = schema.safeParse({ path: 'BE/../secrets' });
      assert.equal(r.success, false);
    });

    it('rejects a path with double slashes', () => {
      const r = schema.safeParse({ path: 'BE//BE0101' });
      assert.equal(r.success, false);
    });

    it('rejects a leading slash', () => {
      const r = schema.safeParse({ path: '/BE/BE0101' });
      assert.equal(r.success, false);
    });

    it('rejects paths with disallowed characters', () => {
      assert.equal(schema.safeParse({ path: 'BE/BE;0101' }).success, false);
      assert.equal(schema.safeParse({ path: 'BE BE 0101' }).success, false);
    });

    it('rejects unknown language / mode / format', () => {
      assert.equal(schema.safeParse({ path: 'X', language: 'de' }).success, false);
      assert.equal(schema.safeParse({ path: 'X', mode: 'query' }).success, false);
      assert.equal(schema.safeParse({ path: 'X', format: 'csv' }).success, false);
    });

    it('accepts a well-formed data query', () => {
      const r = schema.safeParse({
        path: 'BE/BE0101/BE0101A/BefolkningNy',
        mode: 'data',
        query: [{ code: 'Region', values: ['00'], filter: 'item' }],
      });
      assert.equal(r.success, true);
    });
  });

  describe('handler', () => {
    it('issues a GET and returns metadata snapshot', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(METADATA_BODY));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'metadata',
          format: 'json',
        },
        ctx,
      );

      assert.equal(result.isError, undefined);
      const init = fetchMock.mock.calls[0]?.arguments[1] as { method: string };
      assert.equal(init.method, 'GET');

      const structured = result.structuredContent as {
        mode: string;
        title: string;
        variables: Array<Record<string, unknown>>;
      };
      assert.equal(structured.mode, 'metadata');
      assert.equal(structured.title, METADATA_BODY.title);
      assert.equal(structured.variables.length, 4);
      assert.equal(structured.variables[0]?.code, 'Region');
      assert.equal(structured.variables[3]?.time, true);
    });

    it('issues a POST with a JSON body in data mode', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(DATA_BODY));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'data',
          format: 'json',
          query: [
            { code: 'Region', values: ['00'], filter: 'item' },
            { code: 'Tid', values: ['2023'], filter: 'item' },
          ],
        },
        ctx,
      );

      assert.equal(result.isError, undefined);
      const init = fetchMock.mock.calls[0]?.arguments[1] as {
        method: string;
        headers: Record<string, string>;
        body: string;
      };
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json');
      const body = JSON.parse(init.body);
      assert.deepEqual(body, {
        query: [
          { code: 'Region', selection: { filter: 'item', values: ['00'] } },
          { code: 'Tid', selection: { filter: 'item', values: ['2023'] } },
        ],
        response: { format: 'json' },
      });

      const structured = result.structuredContent as {
        mode: string;
        columns: unknown[];
        rows: unknown[];
        raw_format: string;
      };
      assert.equal(structured.mode, 'data');
      assert.equal(structured.columns.length, 4);
      assert.equal(structured.rows.length, 2);
      assert.equal(structured.raw_format, 'json');
    });

    it('returns isError when mode=data has no query', async () => {
      const ctx = makeCtx();
      const result = await tool.handler(
        { path: 'BE/BE0101', language: 'en', mode: 'data', format: 'json' },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result), /requires a non-empty query array/);
    });

    it('returns isError on HTTP 404', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('missing', { status: 404 }));
      const ctx = makeCtx();
      const result = await tool.handler(
        { path: 'NO/SUCH/TABLE', language: 'en', mode: 'metadata', format: 'json' },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result), /404/);
      assert.match(textOf(result), /NO\/SUCH\/TABLE/);
    });

    it('returns isError on HTTP 403 (cell-limit overflow)', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('limit', { status: 403 }));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'data',
          format: 'json',
          query: [{ code: 'Region', values: ['*'], filter: 'all' }],
        },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result), /cell limit/);
    });

    it('throws TransientError on HTTP 429 (rate limit)', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('slow', { status: 429 }));
      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler(
            { path: 'BE/BE0101', language: 'en', mode: 'metadata', format: 'json' },
            ctx,
          ),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /rate-limited/);
          return true;
        },
      );
    });

    it('throws TransientError on HTTP 500', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('x', { status: 500 }));
      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler(
            { path: 'BE/BE0101', language: 'en', mode: 'metadata', format: 'json' },
            ctx,
          ),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on network error', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('ETIMEDOUT');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler(
            { path: 'BE/BE0101', language: 'en', mode: 'metadata', format: 'json' },
            ctx,
          ),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('preserves case-sensitive path in the URL', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => jsonResponse(METADATA_BODY));
      const ctx = makeCtx();
      await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'sv',
          mode: 'metadata',
          format: 'json',
        },
        ctx,
      );
      const url = fetchMock.mock.calls[0]?.arguments[0] as string;
      assert.equal(url, 'https://api.scb.se/OV0104/v1/doris/sv/ssd/BE/BE0101/BE0101A/BefolkningNy');
    });

    it('renders metadata text block with variable sample', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(METADATA_BODY));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'metadata',
          format: 'json',
        },
        ctx,
      );
      const text = textOf(result);
      assert.match(text, /^SCB metadata — BE\/BE0101\/BE0101A\/BefolkningNy \(en\)$/m);
      assert.match(text, /Title: Population by region/);
      assert.match(text, /• Region \(region\) \[eliminable\]/);
      assert.match(text, /• Tid \(year\) \[time\] \[eliminable\]|• Tid \(year\) \[time\]/);
      assert.match(text, /00="Sweden"/);
    });

    it('renders data text block with row sample', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(DATA_BODY));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'data',
          format: 'json',
          query: [{ code: 'Region', values: ['00'], filter: 'item' }],
        },
        ctx,
      );
      const text = textOf(result);
      assert.match(text, /^SCB data — BE\/BE0101\/BE0101A\/BefolkningNy/m);
      assert.match(text, /Rows: 2/);
      assert.match(text, /\[00, 1, 2023\] → 5238760/);
    });

    it('structuredContent validates against outputSchema (metadata)', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(METADATA_BODY));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'metadata',
          format: 'json',
        },
        ctx,
      );
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('handles metadata with missing/partial fields without throwing', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          variables: [
            {
              code: 'X',
              values: ['a', 'b'],
              // no valueTexts, no text, no elimination, no time
            },
          ],
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { path: 'X/Y', language: 'en', mode: 'metadata', format: 'json' },
        ctx,
      );
      const structured = result.structuredContent as {
        title: string | null;
        variables: Array<Record<string, unknown>>;
      };
      assert.equal(structured.title, null);
      assert.equal(structured.variables[0]?.text, '');
      assert.deepEqual(structured.variables[0]?.value_texts, []);
      assert.equal(structured.variables[0]?.elimination, false);
      assert.equal(structured.variables[0]?.time, false);
    });

    it('handles data with missing columns unit and no comments', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          columns: [{ code: 'C' }],
          data: [{ key: ['1'], values: ['100'] }],
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'X/Y',
          language: 'en',
          mode: 'data',
          format: 'json',
          query: [{ code: 'C', values: ['1'], filter: 'item' }],
        },
        ctx,
      );
      const structured = result.structuredContent as {
        columns: Array<{ unit: string | null }>;
        rows: Array<Record<string, unknown>>;
      };
      assert.equal(structured.columns[0]?.unit, null);
      assert.equal(structured.rows.length, 1);
    });

    it('structuredContent validates against outputSchema (data)', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse(DATA_BODY));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          path: 'BE/BE0101/BE0101A/BefolkningNy',
          language: 'en',
          mode: 'data',
          format: 'json',
          query: [{ code: 'Region', values: ['00'], filter: 'item' }],
        },
        ctx,
      );
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });
  });
});
