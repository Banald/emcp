import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 20_000;
const BASE_URL = 'https://data.riksdagen.se/dokumentlista/';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RM_RE = /^\d{4}\/\d{2}$/;

const doktypEnum = z.enum([
  'mot',
  'prop',
  'bet',
  'skr',
  'rskr',
  'sou',
  'ds',
  'fr',
  'frs',
  'ip',
  'yttr',
  'prot',
  'kom',
  'fpm',
  'komm',
]);

const partiEnum = z.enum(['S', 'M', 'SD', 'C', 'V', 'KD', 'L', 'MP']);

const inputSchema = {
  query: z
    .string()
    .max(200)
    .optional()
    .describe('Free-text search (sok). Supports wildcards like "fraktal*". Optional.'),
  doktyp: doktypEnum
    .optional()
    .describe(
      'Document type filter. Common values: "mot" (motion), "prop" (proposition), "bet" (betänkande), "skr" (skrivelse), "sou" (SOU), "ds" (departementsserien), "fr" (skriftlig fråga), "ip" (interpellation), "prot" (protokoll).',
    ),
  rm: z
    .string()
    .regex(RM_RE)
    .optional()
    .describe('Riksmöte (parliamentary session) in "YYYY/YY" format, e.g. "2023/24".'),
  from: z.string().regex(DATE_RE).optional().describe('Lower date bound (YYYY-MM-DD). Inclusive.'),
  tom: z.string().regex(DATE_RE).optional().describe('Upper date bound (YYYY-MM-DD). Inclusive.'),
  parti: partiEnum
    .optional()
    .describe('Filter by political party: S (Socialdemokraterna), M, SD, C, V, KD, L, MP.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe('Results per page (1–50). Default 20.'),
  page: z.number().int().min(1).max(200).default(1).describe('1-based page number. Default 1.'),
  sort: z
    .enum(['rel', 'datum'])
    .default('rel')
    .describe('Sort mode: "rel" (relevance, default) or "datum" (date).'),
};

const documentSchema = z.object({
  id: z.string(),
  dok_id: z.string(),
  rm: z.string(),
  beteckning: z.string(),
  doktyp: z.string(),
  subtyp: z.string(),
  title: z.string(),
  subtitle: z.string(),
  summary: z.string(),
  date: z.string(),
  published: z.string(),
  organ: z.string(),
  html_url: z.string().nullable(),
  text_url: z.string().nullable(),
  status_url: z.string().nullable(),
});

const outputSchema = {
  total_hits: z.number().int().describe('Total matching documents across all pages.'),
  page: z.number().int().describe('Current 1-based page index.'),
  pages: z.number().int().describe('Total pages available for this query.'),
  page_size: z.number().int().describe('Page size used in this request.'),
  next_page_url: z
    .string()
    .nullable()
    .describe('URL of the next page as returned by Riksdagen, or null on the last page.'),
  documents: z.array(documentSchema).describe('Documents in the current page.'),
};

interface RawDocument {
  readonly id?: string;
  readonly dok_id?: string;
  readonly rm?: string;
  readonly beteckning?: string;
  readonly typ?: string;
  readonly subtyp?: string;
  readonly doktyp?: string;
  readonly dokument_url_text?: string;
  readonly dokument_url_html?: string;
  readonly dokumentstatus_url_xml?: string;
  readonly titel?: string;
  readonly undertitel?: string;
  readonly summary?: string;
  readonly datum?: string;
  readonly publicerad?: string;
  readonly organ?: string;
}

interface RawResponse {
  readonly dokumentlista?: {
    readonly '@träffar'?: string;
    readonly '@sida'?: string;
    readonly '@sidor'?: string;
    readonly '@nasta_sida'?: string;
    readonly dokument?: readonly RawDocument[] | RawDocument;
  };
}

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'riksdag-search',
  title: 'Riksdag Search',
  description:
    "Search Sveriges Riksdag (Swedish parliament) documents via data.riksdagen.se's /dokumentlista/. Filter by free-text query, document type (motion, proposition, bet, SOU, etc.), session (riksmöte), date range, or party. Returns document IDs, titles, summaries, issue dates, and direct URLs to HTML/plain-text bodies and XML status. Protocol-relative URLs from the upstream are rewritten to https. Note: content is Swedish. Returns isError when the search has zero hits.",
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 30 },

  handler: async (
    { query, doktyp, rm, from, tom, parti, page_size, page, sort },
    ctx: ToolContext,
  ): Promise<CallToolResult> => {
    ctx.logger.info(
      { query, doktyp, rm, from, tom, parti, page_size, page, sort },
      'riksdag-search invoked',
    );

    const url = new URL(BASE_URL);
    url.searchParams.set('utformat', 'json');
    url.searchParams.set('sz', String(page_size));
    url.searchParams.set('p', String(page));
    url.searchParams.set('sort', sort);
    if (query !== undefined && query.length > 0) {
      url.searchParams.set('sok', query);
      url.searchParams.set('a', 's');
    }
    if (doktyp !== undefined) url.searchParams.set('doktyp', doktyp);
    if (rm !== undefined) url.searchParams.set('rm', rm);
    if (from !== undefined) url.searchParams.set('from', from);
    if (tom !== undefined) url.searchParams.set('tom', tom);
    if (parti !== undefined) url.searchParams.set('parti', parti);

    let response: Response;
    try {
      response = await fetchExternal(url.toString(), {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      });
    } catch (err) {
      throw new TransientError(
        `Riksdagen request failed: ${err instanceof Error ? err.message : String(err)}`,
        'Riksdagen data is temporarily unavailable. Please try again.',
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `Riksdagen returned HTTP ${response.status}`,
        'Riksdagen data is temporarily unavailable. Please try again.',
      );
    }

    const raw = (await response.json()) as RawResponse;
    const list = raw.dokumentlista;
    if (!list) {
      return {
        content: [
          {
            type: 'text',
            text: `Riksdagen returned an unexpected response (no dokumentlista). Query: ${url.toString()}`,
          },
        ],
        isError: true,
      };
    }

    const totalHits = intOrZero(list['@träffar']);
    const currentPage = intOrZero(list['@sida']) || page;
    const pages = intOrZero(list['@sidor']);
    const nextPageUrl = normalizeProtocolRelative(list['@nasta_sida']);

    const documents = coerceDocuments(list.dokument).map(normalizeDocument);

    if (documents.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `Riksdagen returned no documents for the given filters.${query ? ` (Query: "${query}")` : ''}`,
          },
        ],
        isError: true,
        structuredContent: {
          total_hits: totalHits,
          page: currentPage,
          pages,
          page_size,
          next_page_url: nextPageUrl,
          documents: [],
        },
      };
    }

    const text = formatRiksdagText({ totalHits, currentPage, pages, documents, nextPageUrl });

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        total_hits: totalHits,
        page: currentPage,
        pages,
        page_size,
        next_page_url: nextPageUrl,
        documents,
      },
    };
  },
};

export default tool;

export function coerceDocuments(
  raw: readonly RawDocument[] | RawDocument | undefined,
): RawDocument[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.slice();
  if (typeof raw === 'object') return [raw as RawDocument];
  return [];
}

export function normalizeProtocolRelative(url: string | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

export function intOrZero(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

interface NormalizedDocument {
  readonly id: string;
  readonly dok_id: string;
  readonly rm: string;
  readonly beteckning: string;
  readonly doktyp: string;
  readonly subtyp: string;
  readonly title: string;
  readonly subtitle: string;
  readonly summary: string;
  readonly date: string;
  readonly published: string;
  readonly organ: string;
  readonly html_url: string | null;
  readonly text_url: string | null;
  readonly status_url: string | null;
}

export function normalizeDocument(raw: RawDocument): NormalizedDocument {
  return {
    id: raw.id ?? raw.dok_id ?? '',
    dok_id: raw.dok_id ?? raw.id ?? '',
    rm: raw.rm ?? '',
    beteckning: raw.beteckning ?? '',
    doktyp: raw.doktyp ?? raw.typ ?? '',
    subtyp: raw.subtyp ?? '',
    title: raw.titel ?? '',
    subtitle: raw.undertitel ?? '',
    summary: raw.summary ?? '',
    date: raw.datum ?? '',
    published: raw.publicerad ?? '',
    organ: raw.organ ?? '',
    html_url: normalizeProtocolRelative(raw.dokument_url_html),
    text_url: normalizeProtocolRelative(raw.dokument_url_text),
    status_url: normalizeProtocolRelative(raw.dokumentstatus_url_xml),
  };
}

interface FormatArgs {
  readonly totalHits: number;
  readonly currentPage: number;
  readonly pages: number;
  readonly nextPageUrl: string | null;
  readonly documents: readonly NormalizedDocument[];
}

export function formatRiksdagText(args: FormatArgs): string {
  const lines: string[] = [];
  lines.push(
    `Riksdagen — ${args.totalHits.toLocaleString('en-US')} träffar (sida ${args.currentPage}/${args.pages || '?'}, visar ${args.documents.length}).`,
  );
  let rank = 0;
  for (const d of args.documents) {
    rank++;
    lines.push('');
    lines.push(`${rank}. ${d.title || '(ingen titel)'}`);
    if (d.subtitle) lines.push(`   ${d.subtitle}`);
    lines.push(
      `   Typ: ${d.doktyp}${d.subtyp && d.subtyp !== d.doktyp ? `/${d.subtyp}` : ''}   Riksmöte: ${d.rm || '?'}   Beteckning: ${d.beteckning || '?'}   Datum: ${d.date || '?'}`,
    );
    if (d.html_url) lines.push(`   HTML:   ${d.html_url}`);
    if (d.text_url) lines.push(`   Text:   ${d.text_url}`);
    if (d.status_url) lines.push(`   Status: ${d.status_url}`);
    if (d.summary) lines.push(`   ${d.summary}`);
  }
  if (args.nextPageUrl) {
    lines.push('', `Fler resultat: ${args.nextPageUrl}`);
  }
  return lines.join('\n');
}
