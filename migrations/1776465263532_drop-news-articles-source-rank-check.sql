-- Up Migration

-- The CHECK (source_rank BETWEEN 1 AND 15) duplicates the application bound
-- declared in src/shared/news/sources.ts (ARTICLES_PER_SOURCE). A contributor
-- raising the app-side constant would hit a runtime constraint violation on
-- the next fetch-news run, leaving the cache stale — the worst possible
-- coupling. Drop the CHECK; the worker is the only writer, already slices to
-- `articlesPerSource`, and the broader codebase's pattern is "app is the
-- source of truth for bounds" (see e.g. api_keys.rate_limit_per_minute).

ALTER TABLE news_articles DROP CONSTRAINT news_articles_source_rank_check;

-- Down Migration

ALTER TABLE news_articles ADD CONSTRAINT news_articles_source_rank_check CHECK (source_rank BETWEEN 1 AND 15);
