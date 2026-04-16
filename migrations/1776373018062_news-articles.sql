-- Up Migration

CREATE TABLE news_articles (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  source        VARCHAR(32)   NOT NULL
                CHECK (source IN ('aftonbladet', 'expressen', 'svt')),
  source_rank   INT           NOT NULL CHECK (source_rank BETWEEN 1 AND 15),
  url           TEXT          NOT NULL,
  title         TEXT          NOT NULL,
  description   TEXT,
  content       TEXT          NOT NULL,
  published_at  TIMESTAMPTZ,
  fetched_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (source, source_rank)
);

CREATE INDEX idx_news_articles_source_rank
  ON news_articles (source, source_rank);

-- Down Migration

DROP TABLE news_articles;
