-- Up Migration
DROP TABLE IF EXISTS fetched_resources;

-- Down Migration
CREATE TABLE fetched_resources (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url           TEXT NOT NULL,
  status_code   INTEGER NOT NULL,
  content_type  TEXT,
  body          TEXT,
  bytes         INTEGER NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_by    UUID REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX idx_fetched_resources_url ON fetched_resources(url);
CREATE INDEX idx_fetched_resources_fetched_at ON fetched_resources(fetched_at DESC);
