import { DOMParser } from 'linkedom';
import { z } from 'zod';
import { TransientError } from '../lib/errors.ts';
import { fetchExternal } from '../shared/net/egress.ts';
import { USER_AGENT } from '../shared/net/user-agent.ts';
import type { CallToolResult, ToolContext, ToolDefinition } from '../shared/tools/types.ts';

const FETCH_TIMEOUT_MS = 60_000;
const API_URL = 'https://export.arxiv.org/api/query';

const sortBy = z.enum(['relevance', 'lastUpdatedDate', 'submittedDate']);
const sortOrder = z.enum(['ascending', 'descending']);

const inputSchema = {
  query: z
    .string()
    .min(1)
    .max(400)
    .describe(
      'arXiv search query. Passed verbatim as search_query. Supports field prefixes (ti:, au:, abs:, cat:, all:) and boolean operators AND/OR/ANDNOT (uppercase).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe('Maximum entries to return (1–50). Default 10.'),
  start: z
    .number()
    .int()
    .min(0)
    .max(29999)
    .default(0)
    .describe('Zero-based pagination offset. arXiv caps the total result window at 30 000.'),
  sort_by: sortBy
    .default('relevance')
    .describe('Sort key: "relevance" (default), "lastUpdatedDate", or "submittedDate".'),
  sort_order: sortOrder
    .default('descending')
    .describe('Sort direction: "ascending" or "descending" (default).'),
};

const entrySchema = z.object({
  arxiv_id: z.string(),
  arxiv_id_versioned: z.string(),
  title: z.string(),
  abstract: z.string(),
  authors: z.array(z.string()),
  published: z.string(),
  updated: z.string(),
  primary_category: z.string().nullable(),
  categories: z.array(z.string()),
  abs_url: z.string(),
  pdf_url: z.string().nullable(),
  doi: z.string().nullable(),
  journal_ref: z.string().nullable(),
  comment: z.string().nullable(),
});

const outputSchema = {
  query: z.string().describe('Echo of the submitted search_query.'),
  total_results: z.number().int().describe('opensearch:totalResults from the Atom feed.'),
  start_index: z.number().int().describe('opensearch:startIndex from the Atom feed.'),
  items_per_page: z.number().int().describe('opensearch:itemsPerPage from the Atom feed.'),
  results: z.array(entrySchema).describe('Parsed <entry> elements in feed order.'),
};

const tool: ToolDefinition<typeof inputSchema, typeof outputSchema> = {
  name: 'arxiv-search',
  title: 'arXiv Search',
  description:
    'Search arXiv scientific papers via the public Atom API. Returns titles, abstracts, authors, publication timestamps, arXiv IDs (versioned and version-less), primary/secondary categories, and direct abstract + PDF URLs. Supports field prefixes ("ti:", "au:", "abs:", "cat:", "all:") and boolean operators (AND, OR, ANDNOT — uppercase). Use this for academic search when you need the full abstract, not just a title. Throttled to 20 requests per minute to respect arXiv\'s politeness norm of ~3 s between calls.',
  inputSchema,
  outputSchema,
  rateLimit: { perMinute: 20 },

  handler: async (
    { query, limit, start, sort_by, sort_order },
    ctx: ToolContext,
  ): Promise<CallToolResult> => {
    const url = new URL(API_URL);
    url.searchParams.set('search_query', query);
    url.searchParams.set('start', String(start));
    url.searchParams.set('max_results', String(limit));
    url.searchParams.set('sortBy', sort_by);
    url.searchParams.set('sortOrder', sort_order);

    let response: Response;
    try {
      response = await fetchExternal(url.toString(), {
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/atom+xml, application/xml' },
      });
    } catch (err) {
      throw new TransientError(
        `arXiv request failed: ${err instanceof Error ? err.message : String(err)}`,
        'arXiv is temporarily unavailable. Please try again.',
      );
    }

    if (!response.ok) {
      throw new TransientError(
        `arXiv returned HTTP ${response.status}`,
        'arXiv is temporarily unavailable. Please try again.',
      );
    }

    const xml = await response.text();
    const parsed = parseAtomFeed(xml);

    if (parsed.totalResults === 0 && parsed.entries.length === 0) {
      return {
        content: [{ type: 'text', text: `arXiv returned no matches for "${query}".` }],
        isError: true,
        structuredContent: {
          query,
          total_results: 0,
          start_index: parsed.startIndex,
          items_per_page: parsed.itemsPerPage,
          results: [],
        },
      };
    }

    if (parsed.entries.length === 0) {
      // Documented arXiv quirk: non-zero totalResults but empty page. Treat as transient.
      throw new TransientError(
        `arXiv returned empty feed with totalResults=${parsed.totalResults}`,
        'arXiv returned an empty result page. Please retry shortly.',
      );
    }

    const text = formatText(query, parsed);

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        query,
        total_results: parsed.totalResults,
        start_index: parsed.startIndex,
        items_per_page: parsed.itemsPerPage,
        results: parsed.entries,
      },
    };
  },
};

export default tool;

interface Entry {
  readonly arxiv_id: string;
  readonly arxiv_id_versioned: string;
  readonly title: string;
  readonly abstract: string;
  readonly authors: readonly string[];
  readonly published: string;
  readonly updated: string;
  readonly primary_category: string | null;
  readonly categories: readonly string[];
  readonly abs_url: string;
  readonly pdf_url: string | null;
  readonly doi: string | null;
  readonly journal_ref: string | null;
  readonly comment: string | null;
}

interface ParsedFeed {
  readonly totalResults: number;
  readonly startIndex: number;
  readonly itemsPerPage: number;
  readonly entries: readonly Entry[];
}

export function parseAtomFeed(xml: string): ParsedFeed {
  if (!xml) {
    return { totalResults: 0, startIndex: 0, itemsPerPage: 0, entries: [] };
  }

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  } catch {
    return { totalResults: 0, startIndex: 0, itemsPerPage: 0, entries: [] };
  }

  const feed = doc.querySelector('feed');
  if (!feed) return { totalResults: 0, startIndex: 0, itemsPerPage: 0, entries: [] };

  const totalResults = intOf(firstDescendantText(feed, 'opensearch:totalResults', 'totalResults'));
  const startIndex = intOf(firstDescendantText(feed, 'opensearch:startIndex', 'startIndex'));
  const itemsPerPage = intOf(firstDescendantText(feed, 'opensearch:itemsPerPage', 'itemsPerPage'));

  const entryElements = Array.from(feed.children).filter((c) => c.nodeName === 'entry');
  const entries: Entry[] = [];
  for (const entry of entryElements) {
    const parsed = parseEntry(entry as Element);
    if (parsed !== null) entries.push(parsed);
  }

  return { totalResults, startIndex, itemsPerPage, entries };
}

function parseEntry(entry: Element): Entry | null {
  const versionedIdRaw = textOfChild(entry, 'id');
  if (!versionedIdRaw) return null;

  const arxivIdVersioned = stripIdPrefix(versionedIdRaw);
  const arxivId = stripVersion(arxivIdVersioned);

  const title = collapseWhitespace(textOfChild(entry, 'title'));
  const abstract = collapseWhitespace(textOfChild(entry, 'summary'));
  const published = textOfChild(entry, 'published');
  const updated = textOfChild(entry, 'updated');

  const authors: string[] = [];
  for (const authorEl of childrenNamed(entry, 'author')) {
    const name = collapseWhitespace(textOfChild(authorEl, 'name'));
    if (name) authors.push(name);
  }

  const categories: string[] = [];
  let primaryCategory: string | null = null;
  for (const catEl of childrenNamed(entry, 'category')) {
    const term = (catEl as Element).getAttribute('term');
    if (term) categories.push(term);
  }
  for (const pEl of childrenNamed(entry, 'arxiv:primary_category', 'primary_category')) {
    const term = (pEl as Element).getAttribute('term');
    if (term) {
      primaryCategory = term;
      break;
    }
  }

  let absUrl = `https://arxiv.org/abs/${arxivIdVersioned}`;
  let pdfUrl: string | null = null;
  for (const linkEl of childrenNamed(entry, 'link')) {
    const el = linkEl as Element;
    const rel = el.getAttribute('rel');
    const title = el.getAttribute('title');
    const href = el.getAttribute('href');
    if (!href) continue;
    if (title === 'pdf') pdfUrl = href;
    else if (rel === 'alternate') absUrl = href;
  }

  const doi = textOfChildOrNull(entry, 'arxiv:doi', 'doi');
  const journalRef = textOfChildOrNull(entry, 'arxiv:journal_ref', 'journal_ref');
  const comment = textOfChildOrNull(entry, 'arxiv:comment', 'comment');

  return {
    arxiv_id: arxivId,
    arxiv_id_versioned: arxivIdVersioned,
    title,
    abstract,
    authors,
    published,
    updated,
    primary_category: primaryCategory,
    categories,
    abs_url: absUrl,
    pdf_url: pdfUrl,
    doi,
    journal_ref: journalRef,
    comment,
  };
}

function childrenNamed(parent: Element, ...names: string[]): Element[] {
  const out: Element[] = [];
  for (const child of Array.from(parent.children)) {
    if (names.includes(child.nodeName)) out.push(child as Element);
  }
  return out;
}

function textOfChild(parent: Element, ...names: string[]): string {
  for (const child of Array.from(parent.children)) {
    if (names.includes(child.nodeName)) return child.textContent ?? '';
  }
  return '';
}

function textOfChildOrNull(parent: Element, ...names: string[]): string | null {
  const raw = textOfChild(parent, ...names);
  const trimmed = collapseWhitespace(raw);
  return trimmed.length === 0 ? null : trimmed;
}

function firstDescendantText(root: Element, ...names: string[]): string {
  for (const child of Array.from(root.children)) {
    if (names.includes(child.nodeName)) return child.textContent ?? '';
  }
  return '';
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function intOf(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

export function stripIdPrefix(raw: string): string {
  return raw.replace(/^https?:\/\/arxiv\.org\/abs\//, '').trim();
}

export function stripVersion(versionedId: string): string {
  return versionedId.replace(/v\d+$/, '');
}

function formatText(query: string, parsed: ParsedFeed): string {
  const lines: string[] = [];
  lines.push(
    `arXiv results for "${query}" — ${parsed.totalResults.toLocaleString('en-US')} total, showing ${parsed.entries.length} from index ${parsed.startIndex}.`,
  );
  let rank = 0;
  for (const e of parsed.entries) {
    rank++;
    lines.push('');
    lines.push(`${rank}. ${e.title}`);
    lines.push(`   ID: ${e.arxiv_id} (version ${e.arxiv_id_versioned})`);
    lines.push(`   Authors: ${e.authors.length > 0 ? e.authors.join(', ') : '(none listed)'}`);
    lines.push(`   Published: ${e.published}    Updated: ${e.updated}`);
    lines.push(
      `   Category: ${e.primary_category ?? '(none)'}${e.categories.length > 1 ? ` (+ ${e.categories.filter((c) => c !== e.primary_category).join(', ')})` : ''}`,
    );
    lines.push(`   Abs:  ${e.abs_url}`);
    if (e.pdf_url) lines.push(`   PDF:  ${e.pdf_url}`);
    if (e.doi) lines.push(`   DOI:  ${e.doi}`);
    if (e.journal_ref) lines.push(`   Journal ref: ${e.journal_ref}`);
    if (e.comment) lines.push(`   Comment: ${e.comment}`);
    lines.push(`   Abstract: ${e.abstract}`);
  }
  return lines.join('\n');
}
