import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, {
  coerceDocuments,
  formatRiksdagText,
  intOrZero,
  normalizeDocument,
  normalizeProtocolRelative,
} from './riksdag-search.ts';

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

const sampleDoc = (overrides: Record<string, unknown> = {}) => ({
  id: 'HD023173',
  dok_id: 'HD023173',
  rm: '2025/26',
  beteckning: '3173',
  typ: 'mot',
  subtyp: 'mot',
  doktyp: 'mot',
  dokument_url_text: '//data.riksdagen.se/dokument/HD023173.text',
  dokument_url_html: '//data.riksdagen.se/dokument/HD023173.html',
  dokumentstatus_url_xml: '//data.riksdagen.se/dokumentstatus/HD023173.xml',
  titel: 'Utgiftsområde 20 Klimat, miljö och natur',
  undertitel: 'Motion 2025/26:3173 av Nooshi Dadgostar m.fl. (V)',
  summary: 'Motion till riksdagen 2025/26:3173 ...',
  datum: '2025-10-06',
  publicerad: '2025-10-06 12:34:56',
  organ: '',
  ...overrides,
});

describe('riksdag-search helpers', () => {
  it('coerceDocuments handles array, single object, undefined', () => {
    assert.deepEqual(coerceDocuments(undefined), []);
    const single = sampleDoc();
    const coercedSingle = coerceDocuments(single);
    assert.equal(coercedSingle.length, 1);
    assert.equal(coercedSingle[0]?.id, 'HD023173');
    const coercedArray = coerceDocuments([single, sampleDoc({ id: 'X2' })]);
    assert.equal(coercedArray.length, 2);
  });

  it('normalizeProtocolRelative prepends https: to //-prefixed URLs', () => {
    assert.equal(
      normalizeProtocolRelative('//data.riksdagen.se/x.html'),
      'https://data.riksdagen.se/x.html',
    );
    assert.equal(
      normalizeProtocolRelative('https://data.riksdagen.se/x.html'),
      'https://data.riksdagen.se/x.html',
    );
    assert.equal(normalizeProtocolRelative(undefined), null);
    assert.equal(normalizeProtocolRelative(''), null);
  });

  it('intOrZero handles undefined, integers, and garbage', () => {
    assert.equal(intOrZero(undefined), 0);
    assert.equal(intOrZero('42'), 42);
    assert.equal(intOrZero('not a number'), 0);
    assert.equal(intOrZero(''), 0);
  });

  it('normalizeDocument falls back across id / dok_id / typ / doktyp', () => {
    const r1 = normalizeDocument({ id: 'A', titel: 'T' });
    assert.equal(r1.id, 'A');
    assert.equal(r1.dok_id, 'A');
    assert.equal(r1.title, 'T');

    const r2 = normalizeDocument({ dok_id: 'B', typ: 'mot' });
    assert.equal(r2.id, 'B');
    assert.equal(r2.doktyp, 'mot');

    const r3 = normalizeDocument({});
    assert.equal(r3.id, '');
    assert.equal(r3.dok_id, '');
    assert.equal(r3.doktyp, '');
    assert.equal(r3.title, '');
    assert.equal(r3.html_url, null);
    assert.equal(r3.text_url, null);
    assert.equal(r3.status_url, null);
  });

  it('formatRiksdagText handles a rich doc (all optional fields populated)', () => {
    const text = formatRiksdagText({
      totalHits: 5,
      currentPage: 1,
      pages: 1,
      nextPageUrl: 'https://example/next',
      documents: [
        {
          id: 'x',
          dok_id: 'x',
          rm: '2024/25',
          beteckning: '10',
          doktyp: 'mot',
          subtyp: 'mot-sub',
          title: 'A',
          subtitle: 'sub',
          summary: 'ss',
          date: '2024-01-01',
          published: '',
          organ: '',
          html_url: 'https://h',
          text_url: 'https://t',
          status_url: 'https://s',
        },
      ],
    });
    assert.match(text, /^1\. A$/m);
    assert.match(text, /sub/);
    assert.match(text, /\/mot-sub/);
    assert.match(text, /HTML: {3}https:\/\/h/);
    assert.match(text, /Text: {3}https:\/\/t/);
    assert.match(text, /Status: https:\/\/s/);
    assert.match(text, /ss/);
    assert.match(text, /Fler resultat: https:\/\/example\/next/);
  });

  it('formatRiksdagText falls back to Swedish placeholders when fields are empty', () => {
    const text = formatRiksdagText({
      totalHits: 0,
      currentPage: 1,
      pages: 0,
      nextPageUrl: null,
      documents: [
        {
          id: '',
          dok_id: '',
          rm: '',
          beteckning: '',
          doktyp: '',
          subtyp: '',
          title: '',
          subtitle: '',
          summary: '',
          date: '',
          published: '',
          organ: '',
          html_url: null,
          text_url: null,
          status_url: null,
        },
      ],
    });
    assert.match(text, /sida 1\/\?/);
    assert.match(text, /\(ingen titel\)/);
    assert.match(text, /Riksmöte: \?/);
    assert.match(text, /Beteckning: \?/);
    assert.match(text, /Datum: \?/);
    assert.doesNotMatch(text, /HTML:/);
    assert.doesNotMatch(text, /Fler resultat/);
  });

  it('formatRiksdagText omits the subtyp segment when it equals doktyp', () => {
    const text = formatRiksdagText({
      totalHits: 1,
      currentPage: 1,
      pages: 1,
      nextPageUrl: null,
      documents: [
        {
          id: 'x',
          dok_id: 'x',
          rm: '2024/25',
          beteckning: '10',
          doktyp: 'mot',
          subtyp: 'mot',
          title: 'T',
          subtitle: '',
          summary: '',
          date: '2024-01-01',
          published: '',
          organ: '',
          html_url: null,
          text_url: null,
          status_url: null,
        },
      ],
    });
    assert.doesNotMatch(text, /mot\/mot/);
    assert.match(text, /Typ: mot {3}Riksmöte/);
  });
});

describe('riksdag-search tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'riksdag-search');
      assert.equal(tool.title, 'Riksdag Search');
    });

    it('description mentions Riksdag and Swedish', () => {
      assert.match(tool.description, /Riksdag/i);
      assert.match(tool.description, /Swedish/i);
    });

    it('has rate limit 30/min', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 30 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts an empty input (all filters optional)', () => {
      const r = schema.safeParse({});
      assert.equal(r.success, true);
      if (r.success) {
        assert.equal(r.data.page_size, 20);
        assert.equal(r.data.page, 1);
        assert.equal(r.data.sort, 'rel');
      }
    });

    it('rejects a bad rm format', () => {
      assert.equal(schema.safeParse({ rm: '2023-24' }).success, false);
      assert.equal(schema.safeParse({ rm: '23/24' }).success, false);
    });

    it('accepts rm in YYYY/YY format', () => {
      assert.equal(schema.safeParse({ rm: '2023/24' }).success, true);
    });

    it('rejects a bad date format', () => {
      assert.equal(schema.safeParse({ from: '23-1-1' }).success, false);
      assert.equal(schema.safeParse({ tom: '2023/01/01' }).success, false);
    });

    it('rejects an unknown doktyp', () => {
      assert.equal(schema.safeParse({ doktyp: 'unknown' }).success, false);
    });

    it('accepts every known doktyp', () => {
      for (const doktyp of ['mot', 'prop', 'bet', 'skr', 'sou', 'ds', 'fr', 'ip'] as const) {
        assert.equal(schema.safeParse({ doktyp }).success, true);
      }
    });

    it('rejects an unknown parti', () => {
      assert.equal(schema.safeParse({ parti: 'X' }).success, false);
    });

    it('rejects page_size out of range', () => {
      assert.equal(schema.safeParse({ page_size: 0 }).success, false);
      assert.equal(schema.safeParse({ page_size: 51 }).success, false);
    });
  });

  describe('handler', () => {
    it('sends expected query parameters when filters are supplied', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: { '@träffar': '0', '@sida': '1', '@sidor': '0', dokument: [] },
        }),
      );
      const ctx = makeCtx();
      await tool.handler(
        {
          query: 'klimat',
          doktyp: 'mot',
          rm: '2025/26',
          from: '2025-01-01',
          tom: '2025-12-31',
          parti: 'V',
          page_size: 25,
          page: 2,
          sort: 'datum',
        },
        ctx,
      );
      const url = new URL(fetchMock.mock.calls[0]?.arguments[0] as string);
      assert.equal(url.hostname, 'data.riksdagen.se');
      assert.equal(url.pathname, '/dokumentlista/');
      assert.equal(url.searchParams.get('utformat'), 'json');
      assert.equal(url.searchParams.get('sok'), 'klimat');
      assert.equal(url.searchParams.get('a'), 's');
      assert.equal(url.searchParams.get('doktyp'), 'mot');
      assert.equal(url.searchParams.get('rm'), '2025/26');
      assert.equal(url.searchParams.get('from'), '2025-01-01');
      assert.equal(url.searchParams.get('tom'), '2025-12-31');
      assert.equal(url.searchParams.get('parti'), 'V');
      assert.equal(url.searchParams.get('sz'), '25');
      assert.equal(url.searchParams.get('p'), '2');
      assert.equal(url.searchParams.get('sort'), 'datum');
    });

    it('skips the query / a=s params when no query is provided', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: { '@träffar': '0', dokument: [] },
        }),
      );
      const ctx = makeCtx();
      await tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx);
      const url = new URL(fetchMock.mock.calls[0]?.arguments[0] as string);
      assert.equal(url.searchParams.get('sok'), null);
      assert.equal(url.searchParams.get('a'), null);
    });

    it('returns typed documents with https-upgraded URLs', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: {
            '@träffar': '1234',
            '@sida': '1',
            '@sidor': '62',
            '@nasta_sida': '//data.riksdagen.se/dokumentlista/?sok=klimat&p=2',
            dokument: [sampleDoc(), sampleDoc({ id: 'HD0231B', titel: 'Second' })],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'klimat', page_size: 20, page: 1, sort: 'rel' },
        ctx,
      );

      const structured = result.structuredContent as {
        total_hits: number;
        page: number;
        pages: number;
        next_page_url: string;
        documents: Array<Record<string, unknown>>;
      };
      assert.equal(structured.total_hits, 1234);
      assert.equal(structured.page, 1);
      assert.equal(structured.pages, 62);
      assert.equal(
        structured.next_page_url,
        'https://data.riksdagen.se/dokumentlista/?sok=klimat&p=2',
      );
      assert.equal(structured.documents.length, 2);
      assert.equal(structured.documents[0]?.id, 'HD023173');
      assert.equal(
        structured.documents[0]?.html_url,
        'https://data.riksdagen.se/dokument/HD023173.html',
      );
      assert.equal(
        structured.documents[0]?.text_url,
        'https://data.riksdagen.se/dokument/HD023173.text',
      );
      assert.equal(
        structured.documents[0]?.status_url,
        'https://data.riksdagen.se/dokumentstatus/HD023173.xml',
      );
      assert.equal(structured.documents[0]?.title, 'Utgiftsområde 20 Klimat, miljö och natur');
    });

    it('coerces a single-object dokument into an array of one', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: {
            '@träffar': '1',
            '@sida': '1',
            '@sidor': '1',
            dokument: sampleDoc(),
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx);
      const structured = result.structuredContent as {
        documents: Array<Record<string, unknown>>;
      };
      assert.equal(structured.documents.length, 1);
      assert.equal(structured.documents[0]?.id, 'HD023173');
    });

    it('returns isError when the result list is empty', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: { '@träffar': '0', '@sida': '1', '@sidor': '0', dokument: [] },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'nothingmatches', page_size: 20, page: 1, sort: 'rel' },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no documents/i);
    });

    it('returns isError when the response is missing dokumentlista', async () => {
      mock.method(globalThis, 'fetch', async () => jsonResponse({}));
      const ctx = makeCtx();
      const result = await tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx);
      assert.equal(result.isError, true);
      assert.match(textOf(result), /unexpected response/);
    });

    it('throws TransientError on HTTP 5xx', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('ouch', { status: 502 }));
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on network error', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('ECONNABORTED');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () => tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('renders the text block with Swedish labels and numbered entries', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: {
            '@träffar': '10',
            '@sida': '1',
            '@sidor': '1',
            dokument: [sampleDoc()],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'klimat', page_size: 20, page: 1, sort: 'rel' },
        ctx,
      );
      const text = textOf(result);
      assert.match(text, /träffar/);
      assert.match(text, /^1\. Utgiftsområde 20 Klimat/m);
      assert.match(text, /Beteckning: 3173/);
      assert.match(text, /HTML: {3}https:\/\/data\.riksdagen\.se\/dokument\/HD023173\.html/);
    });

    it('structuredContent validates against outputSchema', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: {
            '@träffar': '1',
            '@sida': '1',
            '@sidor': '1',
            dokument: [sampleDoc()],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx);
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });

    it('keeps next_page_url null when upstream omits it', async () => {
      mock.method(globalThis, 'fetch', async () =>
        jsonResponse({
          dokumentlista: {
            '@träffar': '1',
            '@sida': '1',
            '@sidor': '1',
            dokument: [sampleDoc()],
          },
        }),
      );
      const ctx = makeCtx();
      const result = await tool.handler({ page_size: 20, page: 1, sort: 'rel' }, ctx);
      const structured = result.structuredContent as { next_page_url: string | null };
      assert.equal(structured.next_page_url, null);
    });
  });
});
