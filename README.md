# mcp-server

Production-grade MCP server in TypeScript. Streamable HTTP transport, API key authentication with usage metrics, drop-in scheduled background workers, drop-in tool authoring.

## Stack

Node.js 24 LTS · TypeScript · PostgreSQL · Redis · croner · Pino · Prometheus

## Quickstart

```bash
nvm use
npm ci
cp .env.example .env  # then edit secrets — see comments in the file

# First-time DB setup
node --env-file=.env src/db/migrate.ts up

# Create your first key
node --env-file=.env src/cli/keys.ts create --name "local-dev"
# Save the printed key — it will not be shown again.

# Start SearXNG (required for the web-search tool)
cd infra/searxng && docker compose up -d && cd -

# Run server + worker (two terminals)
npm run dev
npm run dev:worker
```

## Project layout

See [`AGENTS.md`](./AGENTS.md) for the full project context. Quick map:

- `src/tools/` — drop a `.ts` file per tool. See [`docs/TOOL_AUTHORING.md`](./docs/TOOL_AUTHORING.md).
- `src/workers/` — drop a `.ts` file per scheduled cron worker. See [`docs/WORKER_AUTHORING.md`](./docs/WORKER_AUTHORING.md).
- `src/shared/` — the contracts (`tools/types.ts`, `tools/loader.ts`, `workers/types.ts`, `workers/loader.ts`, `workers/scheduler.ts`) and cross-cutting helpers (`net/ssrf.ts`) consumed by both. Not meant to be modified by tool or worker authors.
- `src/cli/keys.ts` — API key management. See [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).
- `migrations/` — SQL migrations.

## Deploy from a release

Download the latest release tarball from the [Releases](../../releases) page and extract it:

```bash
tar -xzf echo-v*.tar.gz
cd echo
npm ci --omit=dev
```

Configure the environment:

```bash
cp .env.example .env
# Edit .env — see comments in the file for each variable.
# At minimum: DATABASE_URL, REDIS_URL, API_KEY_HMAC_SECRET,
# PUBLIC_HOST, ALLOWED_ORIGINS.
```

Start SearXNG (required for the `web-search` tool):

```bash
cd infra/searxng && docker compose up -d && cd -
```

Run database migrations and create your first API key:

```bash
node --env-file=.env dist/db/migrate.js up
node --env-file=.env dist/cli/keys.js create --name "production"
# Save the printed key — it will not be shown again.
```

Start with PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

### Required infrastructure

- PostgreSQL 14+
- Redis 7+ (used for rate limiting and cache; no special eviction policy required)
- SearXNG (Docker) — config included in `infra/searxng/`

### Network

The server binds to `127.0.0.1` by default. Front it with a reverse proxy (nginx, Caddy) that handles TLS, sets `X-Forwarded-*` headers, and forwards only `/mcp` externally. `/health` and `/metrics` are loopback-only by design.

## Running from source

Build:

```bash
npm run build
```

Process management with PM2:

```bash
pm2 start ecosystem.config.cjs
pm2 save
```

## Testing

```bash
npm test                    # fast unit tests
npm run test:coverage       # with coverage gate (95/95/90)
npm run test:integration    # full integration tests with Testcontainers
npm run test:all            # everything
```

CI runs all three on every push. See [`docs/TESTING.md`](./docs/TESTING.md).

## Documentation

- [`AGENTS.md`](./AGENTS.md) — start here, read every session
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — tech choices, schema, env, errors
- [`docs/SECURITY.md`](./docs/SECURITY.md) — security rules and audit checklist
- [`docs/TOOL_AUTHORING.md`](./docs/TOOL_AUTHORING.md) — adding tools
- [`docs/WORKER_AUTHORING.md`](./docs/WORKER_AUTHORING.md) — adding workers
- [`docs/OPERATIONS.md`](./docs/OPERATIONS.md) — CLI, migrations, shutdown, health, metrics
- [`docs/TESTING.md`](./docs/TESTING.md) — test patterns, CI
