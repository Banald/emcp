# Architecture

This document explains **why** the system is built the way it is. Read this before making structural decisions or proposing dependency changes.

## System overview

```
┌────────────────┐         HTTPS          ┌──────────────────────────────┐
│  MCP Clients   │ ─────────────────────▶ │   Reverse Proxy (Caddy)      │
│ (Claude, IDEs) │  Authorization: Bearer │   - TLS termination          │
└────────────────┘                         │   - Forwards to MCP server   │
                                           └──────────────┬───────────────┘
                                                          │ HTTP (compose net)
                                                          ▼
                                           ┌──────────────────────────────┐
                                           │   MCP Server (Node.js)       │
                                           │   - Streamable HTTP /mcp     │
                                           │   - Auth middleware          │
                                           │   - Rate limiting            │
                                           │   - Tool dispatch ───────────┼──── HTTP (compose net)
                                           │   - Metrics collection       │            │
                                           └──────┬───────────────┬───────┘            ▼
                                                  │               │          ┌──────────────────┐
                                          cache / │               │ query    │     SearXNG      │
                                          rate    │               │          │  - web-search    │
                                          limit   ▼               ▼          │    backend       │
                                           ┌──────────┐    ┌──────────────┐  │  - port 8080     │
                                           │  Redis   │    │  PostgreSQL  │  └──────────────────┘
                                           │ (cache,  │    │ (API keys,   │          ▲
                                           │  rate    │    │  metrics,    │          │ reads
                                           │  limit)  │    │  worker      │ ─────────┘
                                           └──────────┘    │  tables)     │
                                                           └──────┬───────┘
                                                                  │ writes
                                                                  │
                                           ┌──────────────────────┴───────┐
                                           │   Worker Process             │
                                           │   - croner scheduler         │
                                           │   - Drop-in cron workers     │
                                           └──────────────────────────────┘
```

The MCP server and worker are **separate processes**, supervised by Docker Compose in the production deployment (or by PM2 for bare-metal). The only runtime linkage is Postgres — workers write data, tools read data. Workers never hold an HTTP reference to the server, and tools never enqueue or invoke workers. Redis is used by the server only (rate limiting, cache); the worker process does not open a Redis connection.

## Major decisions and rationale

### MCP transport: Streamable HTTP (not the old HTTP+SSE)

The MCP spec deprecated the dual-endpoint HTTP+SSE transport in 2025-03-26. Streamable HTTP uses a **single endpoint** (`/mcp`) handling both POST (client→server JSON-RPC) and optionally GET (server→client SSE stream for notifications). Session continuity is via the `Mcp-Session-Id` header. We use the official `StreamableHTTPServerTransport` from the SDK — do not hand-roll the protocol.

**Stateful mode** is used so server-initiated messages (progress, logging) reach clients via the open SSE stream. Stateless mode would limit us to request-response only.

### Runtime: Node.js 24 LTS (not Bun, not Deno)

Bun is faster but has imperfect compatibility with the MCP SDK. Deno's npm interop is improving but introduces friction. Node.js 24 gives us:

- **Native TypeScript execution** — no `tsx`/`ts-node` needed in dev. Run `node src/index.ts` directly.
- **Native `--env-file`** — no `dotenv` package needed.
- **Native `node:test`** — no jest/vitest needed.
- Tier-1 support from every dependency we use.

We use `bun install` as the package manager (much faster than npm/yarn) but `node` as the runtime. This is a deliberate hybrid.

### TypeScript configuration

`erasableSyntaxOnly: true` is required for Node.js native type stripping — it forbids `const enum`, `namespace`, parameter properties, and other non-erasable constructs. `verbatimModuleSyntax: true` requires explicit `import type`. These are not optional; the runtime depends on them.

Path aliases (`@/lib/...`) **do not work** with native type stripping because Node.js doesn't read `tsconfig.json` at runtime. Use relative imports.

### Database: PostgreSQL via `pg` (not Prisma, not Drizzle, not postgres.js)

- **`pg`**: 20M+ weekly downloads, 10+ year track record, built-in pooling, universal compatibility. Performance difference vs `postgres.js` is negligible (~200µs vs ~180µs per query).
- **No ORM**: Prisma adds a massive dependency tree and code generation step. Drizzle is lighter but still adds friction. For a server with a small, well-defined schema, raw SQL with `pg` is simpler, faster, and has zero abstraction surprises.
- **Migrations: `node-pg-migrate`** with raw SQL files. Only 2 transitive deps, uses `pg` as a peer.

### Cache and rate limiting: Redis via `ioredis` (not `node-redis`)

`ioredis` has better cluster/sentinel support and automatic reconnection than `node-redis`, and it is the long-established choice in this ecosystem. We use a single Redis instance for rate limiting and ad-hoc caching — one connection, one set of options. No Redis eviction policy constraints (any reasonable policy is fine; `allkeys-lru` is a good default for the rate-limit cache).

### Background jobs: croner (in-process cron)

The worker process (`src/workers/index.ts`) boots, loads every `WorkerDefinition` exported from `src/workers/**/*.ts` via `src/shared/workers/loader.ts`, and hands them to an in-process cron scheduler backed by [`croner`](https://github.com/hexagon/croner). Each definition declares its own schedule, optional timezone, optional per-run timeout, and optional `runOnStartup`. The scheduler guarantees at-most-one concurrent run per worker, records Prometheus metrics, and honors `AbortSignal` for cooperative shutdown.

`croner` is zero-dependency, TypeScript-native, handles DST correctly, and keeps a cron state machine entirely in memory. No Redis, no queue, no broker.

**Trade-off**: cron state is process-local. If the worker is down when a tick would have fired, the tick is missed — workers are for recurring background refresh, not at-least-once delivery. If delivery guarantees are needed, introduce that machinery deliberately (outbox table + retry worker, external scheduler, etc.) rather than reaching for a queue library by default.

**Known limitation**: to scale the worker horizontally, a Redis advisory lock (`SET key NX EX ttl`) must wrap every fire to prevent multi-instance double-firing. Out of scope for the initial migration; `ecosystem.config.cjs` pins `instances: 1` for `mcp-worker`.

### Validation: Zod 4

Zod 4 has **native `z.toJSONSchema()`** support — we don't need the deprecated `zod-to-json-schema` package. The MCP SDK also internally converts Zod schemas to JSON Schema for tool registration, so tool authors write Zod and get JSON Schema for free.

### Logging: Pino

Pino is ~5× faster than Winston, has built-in field redaction (critical for our security posture — see `docs/SECURITY.md`), supports child loggers for context propagation, and can offload formatting to a worker thread. We use `pino-pretty` as a dev dependency only; production logs are JSON.

### Metrics: prom-client

De facto standard for Prometheus metrics in Node.js. Zero production dependencies. Exposes `/metrics` for scraping. We collect: request rate per tool, request duration histogram, API key request count, auth-failure and rate-limit counters, worker run lifecycle (success / failure / timeout / skipped overlap), and worker run duration.

### Testing: node:test + c8

`node:test` is stable, builtin, and feature-complete (describe/it, hooks, mocks, snapshots, watch, parallel). `c8` wraps V8's native coverage — it has the `--all` flag (essential, reports 0% for untested files) and threshold enforcement (`--lines 95`). Node's built-in `--experimental-test-coverage` lacks both.

### Linting: Biome (not ESLint + Prettier)

Single zero-dependency binary. 10-25× faster than ESLint+Prettier. v2 supports type-aware rules. Eliminates an entire dependency tree.

## Approved production dependencies

This list is the source of truth. Adding to it requires explicit user approval per `AGENTS.md`.

| Package | Purpose | Why this one |
|--|--|--|
| `@modelcontextprotocol/sdk` | MCP protocol implementation | Official, only viable choice |
| `zod` | Input validation, JSON Schema generation | Required by SDK; v4 has native JSON Schema |
| `pg` | PostgreSQL client | Universal standard, minimal deps |
| `ioredis` | Redis client (cache + rate limiting) | Mature, cluster/sentinel-aware, well-understood in this codebase |
| `croner` | Cron scheduler for background workers | Zero deps, TypeScript-native, accurate DST handling, no broker required |
| `pino` | Structured logging | Fast, redaction-aware |
| `prom-client` | Prometheus metrics | Zero deps, de facto standard |
| `node-pg-migrate` | Database migrations | Minimal deps, raw SQL files |
| `@mozilla/readability` | Main-content extraction for the `fetch-url` tool | Firefox's Reader Mode algorithm; battle-tested on the real web, no runtime deps |
| `linkedom` | Lightweight DOM for Readability to operate on | Much smaller than `jsdom` (~6 transitive deps vs ~20+), sufficient for static HTML parsing |
| `turndown` | HTML → Markdown conversion for LLM-readable output | Preserves headings/links/lists/code; LLMs handle Markdown structure better than flat text |
| `undici` | HTTP `ProxyAgent` for outbound-egress proxy rotation | Same client Node ships internally; battle-tested `ProxyAgent` supports HTTP + CONNECT tunneling + basic auth. Hand-rolling the CONNECT path over `node:http`+`tls.connect` was the only viable alternative — rejected because the maintenance and TLS edge-case surface exceed the dep cost. Already a transitive dep via `@modelcontextprotocol/sdk` at an older version; direct dep pins the version we test against. |

## Approved dev dependencies

| Package | Purpose |
|--|--|
| `typescript` | Type checking and production build |
| `@types/node` | Node.js type definitions |
| `@types/pg` | pg type definitions |
| `@biomejs/biome` | Lint + format |
| `c8` | Test coverage with thresholds |
| `pino-pretty` | Human-readable dev logs |
| `testcontainers` | Postgres/Redis for integration tests |
| `@testcontainers/postgresql` | Postgres testcontainer helper |
| `@types/turndown` | Type definitions for `turndown` (it ships no types in 7.x) |

## Explicitly rejected

- **Express, Fastify, Hono, Koa**: Use raw `node:http`. The MCP transport handles routing for the `/mcp` endpoint; we only need a thin wrapper for `/health`, `/metrics`, and Origin validation.
- **dotenv**: Replaced by `node --env-file=.env`.
- **tsx, ts-node**: Replaced by Node.js native type stripping.
- **jest, vitest, mocha, chai, sinon**: Replaced by `node:test`.
- **eslint, prettier, typescript-eslint**: Replaced by Biome.
- **winston, bunyan**: Pino is faster and safer.
- **bullmq**: Removed in favor of `croner`. The repo never needed delivery guarantees, retries, or a broker for its background work — just scheduled jobs that read/write Postgres. BullMQ brought Redis-eviction constraints, producer/worker connection-split pitfalls, and a queue abstraction that encouraged tools to drive workers (a boundary violation we explicitly rejected). If a future job genuinely needs at-least-once semantics, reintroduce a queue then — don't keep one around just in case.
- **node-cron**: Evaluated; `croner` has cleaner timezone/DST handling and a smaller API surface.
- **node-redis**: Historical choice; we already run `ioredis` and it remains the more capable client for our needs.
- **prisma, drizzle, knex, typeorm**: Raw SQL with `pg` is sufficient for this scope.
- **zod-to-json-schema**: Deprecated; Zod 4 has native support.
- **bcrypt, argon2 for API keys**: Wrong tool — see `docs/SECURITY.md`.
- **jsdom** (for the `fetch-url` tool): Much heavier dep tree than `linkedom`; we don't need script execution or full browser emulation.
- **cheerio** (for the `fetch-url` tool): Excellent selector library, but doesn't solve the "which part is the article?" problem. Rebuilding Readability's content-scoring on top of it is not worth the effort.

## Version pinning

| Concern | Policy |
|--|--|
| Node.js runtime | **Exact major: Node.js 24 LTS.** Pinned via `.nvmrc` (`24`) and `engines.node` in `package.json` (`>=24.0.0 <25.0.0`). CI uses the same. |
| `@modelcontextprotocol/sdk` | **Tilde range: `~1.26.0`.** Patch updates only. Minor SDK updates can ship behavioral changes; bump deliberately and re-test. Migration to v2 is a deliberate project, not an automatic update. |
| `searxng/searxng` Docker image | **Exact date-stamped tag (e.g. `2026.4.17-8579974f5`).** `:latest` is forbidden in `compose.yaml` — every `docker compose pull` must produce the same hash. Bump this tag deliberately when you upgrade. |
| Other production deps | **Caret range: `^x.y.z`.** Standard semver. Lockfile pins exact versions. |
| Dev deps | **Caret range.** Same policy. |
| Lockfile | Always committed. CI uses `npm ci` (or `bun install --frozen-lockfile`) — never `npm install`. |

## Database schema (baseline)

This is the schema as of the initial build. All future changes go through migrations in `migrations/` (see `docs/OPERATIONS.md`).

```sql
-- API keys: one row per key, never hard-deleted
CREATE TABLE api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_prefix      VARCHAR(20)  NOT NULL,           -- e.g. 'mcp_live_k7Hj9mNq' (first 12+ chars, for identification)
  key_hash        VARCHAR(64)  NOT NULL UNIQUE,    -- HMAC-SHA256(pepper, raw_key)
  name            VARCHAR(255) NOT NULL,           -- human label for the key
  status          VARCHAR(20)  NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'blacklisted', 'deleted')),
  rate_limit_per_minute INT    NOT NULL DEFAULT 60,
  allow_no_origin BOOLEAN      NOT NULL DEFAULT FALSE,  -- permit requests without Origin header
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  blacklisted_at  TIMESTAMPTZ,
  deleted_at      TIMESTAMPTZ,
  -- Aggregate metrics (updated asynchronously per request)
  request_count    BIGINT NOT NULL DEFAULT 0,
  bytes_in         BIGINT NOT NULL DEFAULT 0,
  bytes_out        BIGINT NOT NULL DEFAULT 0,
  total_compute_ms BIGINT NOT NULL DEFAULT 0
);

CREATE INDEX idx_api_keys_status ON api_keys(status) WHERE status = 'active';
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);

-- Per-tool usage breakdown
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

-- Migration tracking (managed by node-pg-migrate, schema may differ slightly)
CREATE TABLE pgmigrations (
  id     SERIAL PRIMARY KEY,
  name   VARCHAR(255) NOT NULL,
  run_on TIMESTAMP    NOT NULL
);
```

**Note**: `api_keys` rows are **never hard-deleted**. Soft-delete sets `status = 'deleted'` and `deleted_at = now()` to preserve historical metrics. The `ON DELETE RESTRICT` on `api_key_tool_usage.key_id` enforces this at the DB level.

Application-specific tool data tables (e.g., a `news_articles` table for the example fetch-news tool) live alongside but are added via migrations as features are built.

## Configuration: environment variables

All configuration lives in environment variables, parsed and validated by Zod at startup in `src/config.ts`. Missing or invalid required vars cause **immediate startup failure** with a clear error.

| Variable | Required | Example | Purpose |
|--|--|--|--|
| `NODE_ENV` | yes | `production` | `development` \| `production` \| `test` |
| `EMCP_PORT` | yes | `3000` | HTTP port for MCP server (bind to loopback) |
| `EMCP_BIND_HOST` | no | `127.0.0.1` | Interface to bind. Bare-metal deploys use `127.0.0.1` (default) and rely on a loopback-only reverse proxy as ingress. Containerized deploys (compose, k8s) set `0.0.0.0` so the proxy container can reach the process across the private bridge network. In both cases the external ingress is the reverse proxy — the app process is never published to a public IP. |
| `EMCP_PUBLIC_HOST` | yes | `mcp.example.com` | Expected `Host` header value (DNS rebinding defense) |
| `EMCP_ALLOWED_ORIGINS` | yes | `https://app.example.com,https://...` | Comma-separated allowlist for `Origin` header |
| `EMCP_DATABASE_URL` | yes | `postgres://user:pass@localhost:5432/mcp` | Postgres connection string |
| `EMCP_DATABASE_POOL_MAX` | no | `20` | Max pool connections. Default 10. |
| `EMCP_REDIS_URL` | yes | `redis://localhost:6379` | Redis connection string |
| `EMCP_API_KEY_HMAC_SECRET` | yes | (32+ random bytes, base64) | HMAC pepper for API key hashing. **Rotating this invalidates ALL keys.** |
| `EMCP_LOG_LEVEL` | no | `info` | Pino level. Default `info` in prod, `debug` in dev. |
| `EMCP_RATE_LIMIT_DEFAULT_PER_MINUTE` | no | `60` | Fallback when key has no override. Default 60. |
| `EMCP_SHUTDOWN_TIMEOUT_MS` | no | `30000` | Graceful shutdown deadline for both processes. Default 30s. |
| `EMCP_SEARXNG_URL` | no | `http://localhost:8080` | SearXNG base URL for the `web-search` tool. Default `http://localhost:8080`. See `infra/searxng/`. |
| `EMCP_PUBLIC_SCHEME` | no (compose only) | `https` | Selects which Caddyfile the caddy container mounts: `https` (default, auto-TLS) or `http` (plaintext, trusted networks only). App code does not read this — it's a compose-layer knob. |
| `EMCP_MCP_MAX_BODY_BYTES` | no | `1048576` | Max POST body size to `/mcp`. Range 1 KiB–16 MiB. Default 1 MiB. |
| `EMCP_MCP_SESSION_IDLE_MS` | no | `1800000` | Idle window after which a stateful session is evicted. Range 1 min–24 h. Default 30 min. |
| `EMCP_MCP_SESSION_CLEANUP_INTERVAL_MS` | no | `60000` | How often the eviction sweep runs. Range 1 s–10 min. Default 1 min. |
| `EMCP_MCP_TOOL_CALL_TIMEOUT_MS` | no | `30000` | Per-tool-call abort timeout. Range 1 s–10 min. Default 30 s. |
| `EMCP_MCP_MAX_SESSIONS_PER_KEY` | no | `32` | Concurrent stateful sessions per API key. Over-cap initialises get `RateLimitError` (`-32029`). Range 1–10000. |
| `EMCP_MCP_MAX_SESSIONS_TOTAL` | no | `10000` | Process-wide session backstop. Over-cap initialises get a `TransientError` (`-32013`, 503) with `Retry-After: 60`. |
| `EMCP_HTTP_REQUEST_TIMEOUT_MS` | no | `60000` | HTTP request-receipt timeout (headers + body). Range 10 s–5 min. Applies to the request phase only; SSE response streams are unaffected. |
| `EMCP_PRE_AUTH_RATE_LIMIT_PER_MINUTE` | no | `600` | Pre-auth cap keyed on the resolved client IP (see `EMCP_TRUSTED_PROXY_CIDRS`). Prevents credential-spray traffic from saturating the auth DB lookup. |
| `EMCP_AUTH_NEG_CACHE_TTL_SECONDS` | no | `60` | TTL for the Redis negative-lookup cache that short-circuits unknown bearer tokens before Postgres. Range 1 s–1 h. Cleared automatically on `ApiKeyRepository.create`. |
| `EMCP_TRUSTED_PROXY_CIDRS` | no | `127.0.0.0/8,::1/128` | Comma-separated CIDRs whose `X-Forwarded-For` header is honoured when picking the rate-limit key. Compose sets the docker bridge CIDRs by default. |
| `EMCP_PROXY_URLS` | no | empty | Comma-separated outbound HTTP(S) proxy URLs (`http(s)://[user:pass@]host:port`). Empty keeps the feature disabled (every external fetch goes direct). See "Proxy egress" below. |
| `EMCP_PROXY_ROTATION` | no | `round-robin` | Selection strategy for the next proxy: `round-robin` or `random`. |
| `EMCP_PROXY_FAILURE_COOLDOWN_MS` | no | `60000` | How long a proxy stays out of rotation after a connect/upstream failure. Range 1 s – 1 h. |
| `EMCP_PROXY_MAX_RETRIES_PER_REQUEST` | no | `3` | Failover budget per request. Clamped to pool size at runtime. Range 1 – 10. |
| `EMCP_PROXY_CONNECT_TIMEOUT_MS` | no | `10000` | CONNECT handshake timeout when tunneling to a proxy. Range 1 s – 60 s. |
| `EMCP_SEARXNG_OUTGOING_PROXIES` | no | empty | Proxies SearXNG engines (Google, Brave, Bing, Qwant, Startpage) rotate through. Independent of `EMCP_PROXY_URLS`. Empty = direct egress. |

Maintain `.env.example` in the repo with all variables, placeholder values, and inline comments. `.env` itself is git-ignored.

## Proxy egress

Outbound HTTP from the MCP server and worker can optionally rotate across a configurable pool of HTTP(S) proxies. Motivation: SearXNG's engine scrapers and several public APIs (arXiv, Wikipedia, SCB, SMHI, Riksdagen) rate-limit or blacklist by source IP, so a single-IP deployment is a scaling liability. The proxy pool turns a blacklist event into a per-proxy recoverable condition rather than a per-deploy outage.

```
     ┌─────────────────┐                ┌──────────────────┐
     │  tool / worker  │                │    mcp-server    │
     │ arxiv-search,   │ fetchExternal()│  (or mcp-worker) │
     │ fetch-url, …    ├──────┐         │  process         │
     └─────────────────┘      │         └──────────────────┘
                              ▼
                     ┌──────────────────┐   pool empty?  direct fetch
                     │  ProxyPool       ├────────────────▶  globalThis.fetch
                     │  (round-robin /  │
                     │   random +       │   pool active?
                     │   cooldown)      ├─────┐
                     └──────────────────┘     │
                                              ▼
                                     ┌──────────────────┐
                                     │ undici.fetch +   │   connect_failure
                                     │ ProxyAgent for   ├──────────────────▶ cooldown,
                                     │ entry pN         │                    next proxy
                                     └────────┬─────────┘
                                              │ CONNECT tunnel
                                              ▼
                                     ┌──────────────────┐
                                     │  HTTP(S) proxy   │
                                     │  (operator-run)  │
                                     └────────┬─────────┘
                                              ▼
                                     ┌──────────────────┐
                                     │    upstream      │
                                     │ (arxiv, wiki, …) │
                                     └──────────────────┘
```

Design choices:

- **`undici.ProxyAgent`** (runtime dep). Chosen over hand-rolling ~300 LOC of CONNECT + TLS over `node:http`. Battle-tested, already a transitive dep via the MCP SDK, and exposes the exact dispatcher contract fetch needs.
- **Rotation is in-process and in-memory.** `createProxyPool` in `src/shared/net/proxy/pool.ts` owns the round-robin cursor, health state, and cooldown arithmetic. Single Node event loop → no locking required. Server and worker hold independent pool instances because they're separate processes; that's fine — each pool's job is to smooth out failures within its own request stream.
- **Connect-level failures vs upstream failures.** Only `connect_failure` and `upstream_failure` (HTTP 407/502 on the proxy CONNECT itself) mark a proxy unhealthy. Aborts and upstream 4xx/5xx leave the proxy alone — those are the client's or the upstream's concern.
- **Transparent failover.** `fetchExternal` retries on the next proxy up to `EMCP_PROXY_MAX_RETRIES_PER_REQUEST` times. Only when every in-budget attempt fails does a `TransientError` surface, mapping to HTTP 503 / JSON-RPC -32013 / `Retry-After`.
- **Internal services are never proxied.** Postgres, Redis, and SearXNG's internal compose URL (`http://searxng:8080`) go over the compose bridge network and stay direct. `web-search` keeps a raw `fetch()` call with an inline comment noting the carve-out; routing the compose-internal hop through an external proxy would create a traffic loop.
- **SearXNG has its own proxy layer.** `EMCP_SEARXNG_OUTGOING_PROXIES` feeds `infra/searxng/settings.template.yml` (rendered at container start by `infra/searxng/entrypoint.sh`) so the engine scrapers rotate independently of the Node-side pool. Operators typically set both to the same list, but the option is there to diverge.
- **Metrics** (`/metrics`): `proxy_requests_total{proxy_id,status}`, `proxy_request_duration_seconds{proxy_id}`, `proxy_cooldowns_total{proxy_id}`, `proxy_pool_healthy` (gauge). `proxy_id` uses the pool-index form (`p0`, `p1`, …) — the full URL is never a label, keeping cardinality bounded and credentials out of the metrics endpoint.
- **Credential redaction.** Every log line that mentions a proxy URL goes through `maskProxyUrl` in `src/shared/net/proxy/redact.ts` (`http://user:pass@h:p` → `http://***@h:p`). The install wizard and `emcp config` use the same helper on their confirmation prints. Startup `ConfigError` messages for malformed proxy URLs use generic wording so a typo in `.env` can't leak a secret to operational logs.

## Error hierarchy

All errors thrown by application code descend from `AppError` in `src/lib/errors.ts`. The HTTP/MCP layer maps them to JSON-RPC error codes and HTTP status codes consistently.

| Class | HTTP | JSON-RPC code | Retryable | When to throw |
|--|--|--|--|--|
| `AppError` (base) | 500 | -32603 | no | Don't throw directly — extend it |
| `ValidationError` | 400 | -32602 | no | Input passed Zod but failed business validation |
| `AuthError` | 401 | -32001..-32003 | no | Missing/malformed/unknown credentials |
| `KeyBlacklistedError` | 403 | -32004 | no | Authenticated key is blacklisted |
| `KeyDeletedError` | 403 | -32005 | no | Authenticated key is soft-deleted |
| `RateLimitError` | 429 | -32029 | yes (after `Retry-After`) | Rate limit exceeded |
| `NotFoundError` | 404 | -32011 | no | Resource lookup returned nothing |
| `ConflictError` | 409 | -32012 | no | Unique constraint, version mismatch, etc. |
| `TransientError` | 503 | -32013 | yes | Upstream timeout, DB connection blip — client may retry |
| `ConfigError` | 500 | -32603 | no | Thrown only at startup; halts the process (never reaches HTTP layer) |

Generic `Error` and uncaught throws map to HTTP 500 / JSON-RPC -32603 with a generic message. The actual error is logged with full stack trace; the client sees no internals.

## Endpoints

| Path | Method | Purpose | Auth |
|--|--|--|--|
| `/mcp` | POST | MCP JSON-RPC over Streamable HTTP | API key required |
| `/mcp` | GET | Optional server→client SSE stream (notifications) | API key required |
| `/mcp` | DELETE | Terminate session (Streamable HTTP) | API key required |
| `/health` | GET | Liveness + readiness probe | none (binds loopback only) |
| `/metrics` | GET | Prometheus metrics scrape endpoint | none (binds loopback only) |

`/health` returns JSON: `{ "status": "ok", "version": "0.1.0", "uptime_s": 123, "checks": { "db": { "status": "ok", "latency_ms": 2 }, "redis": { "status": "ok", "latency_ms": 1 } } }`. Returns HTTP 503 if any dependency check fails. `/metrics` returns Prometheus text format.

Both `/health` and `/metrics` are unauthenticated because the process binds to `127.0.0.1` only — they're inaccessible externally. The reverse proxy must NOT forward these paths to the internet.

## Process model

| Process | Count | Purpose |
|--|--|--|
| `mcp-server` | 1 | HTTP server, MCP transport, auth, tool dispatch |
| `mcp-worker` | 1 | croner scheduler, drop-in cron workers |

Supervised by Docker Compose in the production deployment (`compose.yaml` at the repo root) — one container each for `mcp-server` and `mcp-worker`, running the same image with different `CMD`. Bare-metal deploys use PM2 (`ecosystem.config.cjs`). Both processes share the same codebase and the same Postgres. Only `mcp-server` talks to Redis. Graceful shutdown drains in-flight requests / worker runs with the `EMCP_SHUTDOWN_TIMEOUT_MS` budget; `stop_grace_period` in compose and `kill_timeout` in PM2 are both tuned to match.

**Worker scaling (known limitation)**: `mcp-worker` runs as a single instance because croner schedules are in-memory. Running multiple instances would fire every cron tick per instance. Horizontal scaling requires a Redis advisory lock around every fire — out of scope for the initial migration, documented as a follow-up in `docs/WORKER_AUTHORING.md`.

### Rootless runtime (v2)

The entire stack runs against the operator's **rootless Docker daemon**. No compose service ever sees `/var/run/docker.sock`; no container runs as host-root. Two consequences shape the architecture:

- **UID namespaces.** When a container declares `USER emcp` (uid 10001 in our Dockerfile), the uid inside the container maps to a subuid on the host — typically `${subuid_start} + 10001`, where `subuid_start` comes from `/etc/subuid`. Bind-mounted files need the "other" permission bit set because the subuid is neither the file's owner (uid 0 inside the container, which is the operator on the host) nor group. All secrets live at mode `0644` for that reason; the entry in `secrets/README.md` records the rationale.
- **Privileged host ports.** Rootless cannot publish `<1024` on the host. Caddy still binds **internal** `:80`/`:443` (CAP_NET_BIND_SERVICE retained inside the userns), but the published ports default to `8080` / `8443`. See `README.md` "Public port binding in rootless mode" for the three ways to serve public 80/443.

No iptables bypass: rootless uses `slirp4netns` for host ↔ container networking, routing host-side publish traffic through user-space instead of forging iptables rules. This removes the entire class of "docker published port is exempt from UFW" surprises that afflicts rootful deployments (OWASP Docker Cheat Sheet rule #5a).

### Defense in depth (OWASP Docker Cheat Sheet)

Every compose service in v2 enforces:

| Control | Mechanism | Where |
|---|---|---|
| No daemon-socket exposure (#1) | compose never mounts `docker.sock` | `compose.yaml`; asserted by `install.test.sh` |
| Non-root container user (#2) | `USER emcp` (uid 10001) in `Dockerfile` | Caddy retains container-root under userns |
| Cap drop ALL + minimal add (#3) | `cap_drop: [ALL]` + per-service `cap_add` | every service |
| No new privileges (#4) | `security_opt: [no-new-privileges:true]` | every service |
| Network plane split (#5) | `emcp_data` is `internal: true`; postgres/redis only | named networks |
| LSMs default (#6) | Docker's default seccomp + host AppArmor; no `unconfined` | asserted by `install.test.sh` |
| Resource limits (#7) | `mem_limit` / `pids_limit` / `cpus` / `ulimits.nofile` | per service |
| Read-only rootfs (#8) | `read_only: true` + targeted tmpfs overlays | per service |
| Image scanning (#9) | Trivy gate on CI; fails on unfixed CRITICAL/HIGH | `.github/workflows/ci.yml` |
| Rootless daemon (#11) | preflight refuses rootful | `scripts/preflight-rootless.sh` |
| Docker secrets (#12) | postgres / redis / HMAC pepper via `secrets:` | `compose.yaml` + `secrets/` |
| Supply chain (#13) | base images digest-pinned; SBOM + provenance; cosign keyless | `Dockerfile`, release workflow |

## Data flow: a tool call

1. Client sends `POST /mcp` with `Authorization: Bearer mcp_live_...` and JSON-RPC `tools/call`.
2. HTTP layer validates `Origin` and `Host` headers (DNS rebinding defense).
3. Auth middleware extracts the bearer token, HMAC-hashes it, looks it up in Postgres.
4. If blacklisted/deleted/missing: return JSON-RPC error with appropriate code.
5. Rate limiter checks Redis sliding window for this key. If exceeded: return 429.
6. MCP transport dispatches to the named tool handler.
7. Tool handler executes and queries Postgres (or external APIs) as needed. Tools never invoke or enqueue workers.
8. Response sent back; metrics (request count, bytes, compute time) updated in Postgres asynchronously to avoid blocking the response.

## Data flow: a scheduled worker run

1. croner fires the worker's cron on schedule.
2. Scheduler checks the per-worker `inFlight` flag; if the previous run is still executing, the tick is logged as `worker_fire_skipped` and dropped. Otherwise `inFlight = true`.
3. Scheduler creates a per-run `run_id`, a child logger, and an `AbortSignal` combining the shutdown signal with a per-run timeout (default 5 minutes).
4. Handler runs: reads / writes Postgres, calls external APIs. Honors `ctx.signal`.
5. On success: `worker_runs_total{status="success"}` and `worker_run_duration_seconds` are recorded.
6. On throw: `worker_runs_total{status="failure"}` is recorded. The next cron tick still fires — there is no retry plumbing beyond the cron cadence.
7. On timeout: the signal aborts, the scheduler marks `worker_runs_total{status="timeout"}`, releases `inFlight`, and moves on.

A tool that wants to surface worker output queries the Postgres tables the worker writes. The tool and the worker share no runtime objects.
