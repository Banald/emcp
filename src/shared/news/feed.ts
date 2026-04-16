import { DOMParser } from 'linkedom';

export interface FeedItem {
  readonly title: string;
  readonly link: string;
  readonly description?: string;
  readonly publishedAt?: Date;
}

/**
 * Parse an RSS 2.0 or Atom 1.0 feed XML string into `FeedItem`s, in feed order.
 *
 * - Never throws; malformed XML or empty feeds yield `[]`.
 * - Items missing a usable `title` or `link` are skipped.
 * - Whitespace is trimmed; HTML entities are decoded by the parser.
 * - `publishedAt` is undefined when the feed omits the field or the value is unparseable.
 */
export function parseFeed(xml: string): FeedItem[] {
  if (!xml) return [];

  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'text/xml') as unknown as Document;
  } catch {
    return [];
  }

  const rssItems = doc.querySelectorAll('channel > item');
  if (rssItems.length > 0) {
    return readItems(rssItems, extractRssItem);
  }

  const atomEntries = doc.querySelectorAll('feed > entry');
  if (atomEntries.length > 0) {
    return readItems(atomEntries, extractAtomEntry);
  }

  return [];
}

function readItems(
  nodes: NodeListOf<Element>,
  extract: (el: Element) => FeedItem | null,
): FeedItem[] {
  const out: FeedItem[] = [];
  for (const node of nodes) {
    const item = extract(node);
    if (item !== null) out.push(item);
  }
  return out;
}

function extractRssItem(item: Element): FeedItem | null {
  const title = text(item.querySelector('title'));
  const link = text(item.querySelector('link'));
  if (!title || !link) return null;

  const description = text(item.querySelector('description'));
  const pubDateRaw = text(item.querySelector('pubDate'));
  const publishedAt = parseDate(pubDateRaw);

  return buildItem(title, link, description, publishedAt);
}

function extractAtomEntry(entry: Element): FeedItem | null {
  const title = text(entry.querySelector('title'));
  const link = atomEntryLink(entry);
  if (!title || !link) return null;

  const description = text(entry.querySelector('summary')) ?? text(entry.querySelector('content'));
  const publishedAt =
    parseDate(text(entry.querySelector('published'))) ??
    parseDate(text(entry.querySelector('updated')));

  return buildItem(title, link, description, publishedAt);
}

function atomEntryLink(entry: Element): string | undefined {
  // Atom spec: prefer <link rel="alternate">; fall back to the first <link>.
  const links = entry.querySelectorAll('link');
  let first: string | undefined;
  for (const link of links) {
    const href = link.getAttribute('href')?.trim();
    if (!href) continue;
    const rel = link.getAttribute('rel');
    if (rel === null || rel === 'alternate') return href;
    first ??= href;
  }
  return first;
}

function buildItem(
  title: string,
  link: string,
  description: string | undefined,
  publishedAt: Date | undefined,
): FeedItem {
  const item: { -readonly [K in keyof FeedItem]: FeedItem[K] } = { title, link };
  if (description !== undefined) item.description = description;
  if (publishedAt !== undefined) item.publishedAt = publishedAt;
  return item;
}

function text(el: Element | null): string | undefined {
  if (el === null) return undefined;
  const raw = el.textContent ?? '';
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseDate(raw: string | undefined): Date | undefined {
  if (raw === undefined) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : undefined;
}
