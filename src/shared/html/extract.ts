import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';

// Stateless across calls; constructing once avoids per-call rule-compilation cost.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '_',
  linkStyle: 'inlined',
});
turndown.remove(['script', 'style', 'noscript', 'iframe']);
// svg is not in HTMLElementTagNameMap; strip it via a filter function instead.
turndown.remove((node) => node.nodeName === 'SVG');

export interface ArticleExtraction {
  readonly title?: string;
  readonly byline?: string;
  readonly siteName?: string;
  readonly markdown: string;
  readonly fallback: boolean;
}

/**
 * Parse an HTML document and return a cleaned Markdown representation of its
 * main content. Uses Mozilla Readability to identify the article body; if
 * Readability yields nothing (e.g. a page with no article-shaped content),
 * falls back to converting the whole body to Markdown.
 */
export function extractArticle(html: string, baseUrl: string): ArticleExtraction {
  const withBase = injectBaseHref(html, baseUrl);

  try {
    const { document } = parseHTML(withBase);
    // linkedom's Document is structurally compatible with DOM's Document for the subset
    // Readability uses, but the nominal types differ and this project does not enable the
    // DOM lib. A cast here is load-bearing; Readability's real requirement is the shape,
    // not the type identity.
    const reader = new Readability(document as unknown as Document, { charThreshold: 200 });
    const article = reader.parse();
    if (article?.content) {
      const md = htmlToMarkdown(article.content);
      if (md.length > 0) {
        return {
          title: article.title?.trim() || undefined,
          byline: article.byline?.trim() || undefined,
          siteName: article.siteName?.trim() || undefined,
          markdown: md,
          fallback: false,
        };
      }
    }
  } catch {
    /* fall through to fallback */
  }

  let title: string | undefined;
  let bodyHtml = withBase;
  try {
    const { document } = parseHTML(withBase);
    title = document.querySelector('title')?.textContent?.trim() || undefined;
    const body = document.querySelector('body');
    if (body) bodyHtml = body.innerHTML;
  } catch {
    /* use raw HTML */
  }

  return {
    title,
    markdown: htmlToMarkdown(bodyHtml),
    fallback: true,
  };
}

/** Convert an HTML fragment to Markdown, normalizing whitespace. */
export function htmlToMarkdown(html: string): string {
  let md: string;
  try {
    md = turndown.turndown(html);
  } catch {
    md = html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return md
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function injectBaseHref(html: string, baseUrl: string): string {
  const escaped = baseUrl.replace(/"/g, '&quot;');
  const tag = `<base href="${escaped}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (m) => `${m}${tag}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  }
  return `<html><head>${tag}</head><body>${html}</body></html>`;
}
