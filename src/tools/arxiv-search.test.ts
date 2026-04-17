import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { ToolContext } from '../shared/tools/types.ts';
import tool, { parseAtomFeed, stripIdPrefix, stripVersion } from './arxiv-search.ts';

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

const xmlResponse = (body: string, status = 200): Response =>
  new Response(body, {
    status,
    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
  });

const textOf = (result: Awaited<ReturnType<typeof tool.handler>>): string =>
  (result.content[0] as { type: 'text'; text: string }).text;

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/"
      xmlns:arxiv="http://arxiv.org/schemas/atom">
  <title>ArXiv Query</title>
  <opensearch:totalResults>1000</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>2</opensearch:itemsPerPage>
  <entry>
    <id>http://arxiv.org/abs/hep-ex/0307015v1</id>
    <updated>2003-07-07T13:46:39-04:00</updated>
    <published>2003-07-07T13:46:39-04:00</published>
    <title>Multi-Electron Production at High Transverse
      Momenta in ep Collisions at HERA</title>
    <summary>Multi-electron production is studied
      at high transverse momentum in positron-proton collisions at HERA.</summary>
    <author><name>H1 Collaboration</name></author>
    <author><name>Alice Contributor</name></author>
    <arxiv:comment>23 pages, 8 figures and 4 tables</arxiv:comment>
    <arxiv:journal_ref>Eur.Phys.J. C31 (2003) 17-29</arxiv:journal_ref>
    <arxiv:doi>10.1140/epjc/s2003-01326-x</arxiv:doi>
    <link href="http://arxiv.org/abs/hep-ex/0307015v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/hep-ex/0307015v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="hep-ex" scheme="http://arxiv.org/schemas/atom"/>
    <category term="hep-ex" scheme="http://arxiv.org/schemas/atom"/>
    <category term="hep-ph" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2301.12345v2</id>
    <updated>2023-05-01T00:00:00Z</updated>
    <published>2023-01-30T00:00:00Z</published>
    <title>Modern Paper</title>
    <summary>Short summary.</summary>
    <author><name>Jane Doe</name></author>
    <link href="http://arxiv.org/abs/2301.12345v2" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2301.12345v2" rel="related" type="application/pdf"/>
    <arxiv:primary_category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

const EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <title>ArXiv Query</title>
  <opensearch:totalResults>0</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>0</opensearch:itemsPerPage>
</feed>`;

const TRANSIENT_EMPTY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>500</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>0</opensearch:itemsPerPage>
</feed>`;

describe('arxiv-search helpers', () => {
  it('stripIdPrefix removes the abs/ URL prefix', () => {
    assert.equal(stripIdPrefix('http://arxiv.org/abs/2301.12345v2'), '2301.12345v2');
    assert.equal(stripIdPrefix('https://arxiv.org/abs/hep-ex/0307015v1'), 'hep-ex/0307015v1');
  });

  it('stripVersion removes trailing vN while preserving legacy slash IDs', () => {
    assert.equal(stripVersion('2301.12345v2'), '2301.12345');
    assert.equal(stripVersion('hep-ex/0307015v1'), 'hep-ex/0307015');
    assert.equal(stripVersion('2301.12345'), '2301.12345');
  });

  it('parseAtomFeed handles empty input', () => {
    const out = parseAtomFeed('');
    assert.equal(out.entries.length, 0);
    assert.equal(out.totalResults, 0);
  });

  it('parseAtomFeed returns zeros when root is missing', () => {
    const out = parseAtomFeed('<something/>');
    assert.equal(out.entries.length, 0);
  });
});

describe('arxiv-search tool', () => {
  beforeEach(() => {
    mock.reset();
  });

  afterEach(() => {
    mock.reset();
  });

  describe('metadata', () => {
    it('has correct name and title', () => {
      assert.equal(tool.name, 'arxiv-search');
      assert.equal(tool.title, 'arXiv Search');
    });

    it('description mentions arXiv, Atom, and field prefixes', () => {
      assert.match(tool.description, /arXiv/);
      assert.match(tool.description, /Atom/);
      assert.match(tool.description, /ti:|au:/);
    });

    it('has throttled rate limit (20/min) per arXiv politeness', () => {
      assert.deepEqual(tool.rateLimit, { perMinute: 20 });
    });
  });

  describe('input schema validation', () => {
    const schema = z.object(tool.inputSchema);

    it('accepts a query with defaults', () => {
      const r = schema.safeParse({ query: 'ti:transformer' });
      assert.equal(r.success, true);
      if (r.success) {
        assert.equal(r.data.limit, 10);
        assert.equal(r.data.start, 0);
        assert.equal(r.data.sort_by, 'relevance');
        assert.equal(r.data.sort_order, 'descending');
      }
    });

    it('rejects an empty query', () => {
      assert.equal(schema.safeParse({ query: '' }).success, false);
    });

    it('rejects a query longer than 400 chars', () => {
      assert.equal(schema.safeParse({ query: 'a'.repeat(401) }).success, false);
    });

    it('rejects limit>50 and start>=30000', () => {
      assert.equal(schema.safeParse({ query: 'x', limit: 51 }).success, false);
      assert.equal(schema.safeParse({ query: 'x', start: 30000 }).success, false);
    });

    it('rejects unknown sort_by / sort_order', () => {
      assert.equal(schema.safeParse({ query: 'x', sort_by: 'alpha' }).success, false);
      assert.equal(schema.safeParse({ query: 'x', sort_order: 'up' }).success, false);
    });
  });

  describe('handler', () => {
    it('parses a multi-entry feed into typed results', async () => {
      mock.method(globalThis, 'fetch', async () => xmlResponse(FIXTURE_XML));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          query: 'electron',
          limit: 10,
          start: 0,
          sort_by: 'relevance',
          sort_order: 'descending',
        },
        ctx,
      );

      assert.equal(result.isError, undefined);
      const structured = result.structuredContent as {
        total_results: number;
        start_index: number;
        items_per_page: number;
        results: Array<Record<string, unknown>>;
      };
      assert.equal(structured.total_results, 1000);
      assert.equal(structured.items_per_page, 2);
      assert.equal(structured.results.length, 2);

      const first = structured.results[0];
      assert.equal(first?.arxiv_id_versioned, 'hep-ex/0307015v1');
      assert.equal(first?.arxiv_id, 'hep-ex/0307015');
      assert.equal(
        first?.title,
        'Multi-Electron Production at High Transverse Momenta in ep Collisions at HERA',
      );
      assert.match(first?.abstract as string, /^Multi-electron production is studied/);
      assert.deepEqual(first?.authors, ['H1 Collaboration', 'Alice Contributor']);
      assert.equal(first?.primary_category, 'hep-ex');
      assert.deepEqual(first?.categories, ['hep-ex', 'hep-ph']);
      assert.equal(first?.abs_url, 'http://arxiv.org/abs/hep-ex/0307015v1');
      assert.equal(first?.pdf_url, 'http://arxiv.org/pdf/hep-ex/0307015v1');
      assert.equal(first?.doi, '10.1140/epjc/s2003-01326-x');
      assert.equal(first?.journal_ref, 'Eur.Phys.J. C31 (2003) 17-29');
      assert.equal(first?.comment, '23 pages, 8 figures and 4 tables');

      const second = structured.results[1];
      assert.equal(second?.arxiv_id_versioned, '2301.12345v2');
      assert.equal(second?.arxiv_id, '2301.12345');
      assert.equal(second?.doi, null);
      assert.equal(second?.comment, null);
    });

    it('sends the expected query parameters and User-Agent header', async () => {
      const fetchMock = mock.method(globalThis, 'fetch', async () => xmlResponse(FIXTURE_XML));
      const ctx = makeCtx();
      await tool.handler(
        {
          query: 'au:hinton AND cat:cs.LG',
          limit: 5,
          start: 40,
          sort_by: 'submittedDate',
          sort_order: 'ascending',
        },
        ctx,
      );

      assert.equal(fetchMock.mock.callCount(), 1);
      const [urlArg, initArg] = fetchMock.mock.calls[0]?.arguments ?? [];
      const url = new URL(urlArg as string);
      assert.equal(url.hostname, 'export.arxiv.org');
      assert.equal(url.pathname, '/api/query');
      assert.equal(url.searchParams.get('search_query'), 'au:hinton AND cat:cs.LG');
      assert.equal(url.searchParams.get('start'), '40');
      assert.equal(url.searchParams.get('max_results'), '5');
      assert.equal(url.searchParams.get('sortBy'), 'submittedDate');
      assert.equal(url.searchParams.get('sortOrder'), 'ascending');

      const init = initArg as { headers: Record<string, string> };
      assert.equal(init.headers['User-Agent'], USER_AGENT);
    });

    it('returns isError when totalResults=0 and no entries', async () => {
      mock.method(globalThis, 'fetch', async () => xmlResponse(EMPTY_XML));
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'zzz', limit: 10, start: 0, sort_by: 'relevance', sort_order: 'descending' },
        ctx,
      );
      assert.equal(result.isError, true);
      assert.match(textOf(result), /no matches for "zzz"/);
    });

    it('throws TransientError on empty page with non-zero totalResults (documented quirk)', async () => {
      mock.method(globalThis, 'fetch', async () => xmlResponse(TRANSIENT_EMPTY_XML));
      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler(
            { query: 'x', limit: 10, start: 0, sort_by: 'relevance', sort_order: 'descending' },
            ctx,
          ),
        (err: unknown) => {
          assert.ok(err instanceof TransientError);
          assert.match(err.message, /empty feed.*totalResults=500/);
          return true;
        },
      );
    });

    it('throws TransientError on HTTP 503', async () => {
      mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler(
            { query: 'x', limit: 10, start: 0, sort_by: 'relevance', sort_order: 'descending' },
            ctx,
          ),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('throws TransientError on network error', async () => {
      mock.method(globalThis, 'fetch', async () => {
        throw new Error('ECONNRESET');
      });
      const ctx = makeCtx();
      await assert.rejects(
        () =>
          tool.handler(
            { query: 'x', limit: 10, start: 0, sort_by: 'relevance', sort_order: 'descending' },
            ctx,
          ),
        (err: unknown) => err instanceof TransientError,
      );
    });

    it('renders text block with numbered entries, IDs, and abstract', async () => {
      mock.method(globalThis, 'fetch', async () => xmlResponse(FIXTURE_XML));
      const ctx = makeCtx();
      const result = await tool.handler(
        {
          query: 'electron',
          limit: 10,
          start: 0,
          sort_by: 'relevance',
          sort_order: 'descending',
        },
        ctx,
      );
      const text = textOf(result);
      assert.match(text, /^1\. Multi-Electron Production/m);
      assert.match(text, /ID: hep-ex\/0307015 \(version hep-ex\/0307015v1\)/);
      assert.match(text, /PDF: {2}http:\/\/arxiv\.org\/pdf\/hep-ex\/0307015v1/);
      assert.match(text, /Abstract: Multi-electron production is studied/);
      assert.match(text, /^2\. Modern Paper/m);
    });

    it('structuredContent validates against outputSchema', async () => {
      mock.method(globalThis, 'fetch', async () => xmlResponse(FIXTURE_XML));
      const ctx = makeCtx();
      const result = await tool.handler(
        { query: 'e', limit: 10, start: 0, sort_by: 'relevance', sort_order: 'descending' },
        ctx,
      );
      const schema = z.object(tool.outputSchema ?? {});
      const parsed = schema.safeParse(result.structuredContent);
      assert.equal(parsed.success, true, parsed.success ? '' : parsed.error.message);
    });
  });
});
