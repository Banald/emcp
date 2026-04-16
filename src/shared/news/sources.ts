export type NewsSourceKey = 'aftonbladet' | 'expressen' | 'svt';

export interface NewsSource {
  readonly key: NewsSourceKey;
  readonly name: string;
  readonly rssUrl: string;
}

export const NEWS_SOURCES: readonly NewsSource[] = Object.freeze([
  {
    key: 'aftonbladet',
    name: 'Aftonbladet',
    rssUrl: 'https://rss.aftonbladet.se/rss2/small/pages/sections/senastenytt/',
  },
  {
    key: 'expressen',
    name: 'Expressen',
    rssUrl: 'https://feeds.expressen.se/nyheter/',
  },
  {
    key: 'svt',
    name: 'SVT Nyheter',
    rssUrl: 'https://www.svt.se/rss.xml',
  },
] as const satisfies readonly NewsSource[]);

export const ARTICLES_PER_SOURCE = 15;
