-- Up Migration

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE api_keys (
  id                    UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix            VARCHAR(20)   NOT NULL,
  key_hash              VARCHAR(64)   NOT NULL UNIQUE,
  name                  VARCHAR(255)  NOT NULL,
  status                VARCHAR(20)   NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'blacklisted', 'deleted')),
  rate_limit_per_minute INT           NOT NULL DEFAULT 60,
  allow_no_origin       BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ   NOT NULL DEFAULT now(),
  last_used_at          TIMESTAMPTZ,
  blacklisted_at        TIMESTAMPTZ,
  deleted_at            TIMESTAMPTZ,
  request_count         BIGINT        NOT NULL DEFAULT 0,
  bytes_in              BIGINT        NOT NULL DEFAULT 0,
  bytes_out             BIGINT        NOT NULL DEFAULT 0,
  total_compute_ms      BIGINT        NOT NULL DEFAULT 0
);

CREATE INDEX idx_api_keys_status ON api_keys(status) WHERE status = 'active';
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

CREATE TABLE api_key_tool_usage (
  key_id           UUID         NOT NULL REFERENCES api_keys(id) ON DELETE RESTRICT,
  tool_name        VARCHAR(255) NOT NULL,
  invocation_count BIGINT       NOT NULL DEFAULT 0,
  total_compute_ms BIGINT       NOT NULL DEFAULT 0,
  bytes_in         BIGINT       NOT NULL DEFAULT 0,
  bytes_out        BIGINT       NOT NULL DEFAULT 0,
  last_used_at     TIMESTAMPTZ,
  PRIMARY KEY (key_id, tool_name)
);

-- Down Migration

DROP TABLE api_key_tool_usage;
DROP TABLE api_keys;
