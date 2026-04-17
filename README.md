# mcp-server

Production-grade MCP server in TypeScript. Streamable HTTP transport, API key authentication with usage metrics, drop-in scheduled background workers, drop-in tool authoring.

## Stack

Node.js 24 LTS · TypeScript · PostgreSQL · Redis · croner · Pino · Prometheus

## Quickstart (local dev)

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
docker compose up -d searxng

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

## Deploy with Docker Compose

The preferred deployment path. One Dockerfile, one compose file, the whole
stack (Postgres, Redis, SearXNG, Caddy, server, worker) comes up together.

### Prerequisites

- Docker 24+ with Compose v2
- Ports 80 and 443 available on the host (or override via `HTTP_PORT` / `HTTPS_PORT`)

### Steps

```bash
git clone https://github.com/Banald/echo.git
cd echo

# 1. Configure
cp .env.example .env
# Edit .env — at minimum set PUBLIC_HOST and ALLOWED_ORIGINS. Change
# SEARXNG_SECRET to a fresh value.

# 2. Create Docker secrets
mkdir -p secrets
openssl rand -base64 24 > secrets/postgres_password.txt
openssl rand -base64 32 > secrets/api_key_hmac_secret.txt
chmod 0600 secrets/*.txt

# 3. Authenticate to ghcr.io
# The Echo container image lives at ghcr.io/banald/echo and the source
# repo is private — so this registry requires auth before `up -d`. Create
# a Personal Access Token (classic) with the `read:packages` scope at
# https://github.com/settings/tokens/new?scopes=read:packages and then:
echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin
# Shortcut if you already have gh CLI with the packages scope:
#   gh auth refresh --scopes read:packages
#   gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin

# 4. Bring up the stack (pulls the prebuilt image; builds from source if
#    ECHO_PULL_POLICY=build is set in .env)
docker compose up -d

# 5. Create your first API key
docker compose run --rm mcp-server node dist/cli/keys.js create --name "production"
# Save the printed key — it will not be shown again.

# 6. Tail logs
docker compose logs -f mcp-server mcp-worker
```

Migrations run automatically via a one-shot `migrate` service on every
`docker compose up`. To apply pending migrations without touching the rest:

```bash
docker compose run --rm migrate
```

### Pinning a specific version

By default compose pulls `ghcr.io/banald/echo:latest`. To pin a release tag
(recommended for production), set in `.env`:

```
ECHO_IMAGE_TAG=v0.5.1
ECHO_PULL_POLICY=always
```

Then `docker compose pull && docker compose up -d` to refresh.

### Building from source instead of pulling

If you've forked the repo, or you're iterating on the image locally, skip
the ghcr.io login and build from source instead:

```
ECHO_PULL_POLICY=build
```

in `.env`. First `up -d` will build the image from the working tree.

### TLS

Caddy picks a strategy based on `PUBLIC_HOST`:

- `localhost`, `127.0.0.1`, or an IP literal → internal CA (self-signed).
  Trust once with `caddy trust` if you want browsers to stop warning.
- A real public hostname → Let's Encrypt. Requires DNS A/AAAA pointing at the
  host and ports 80/443 reachable from the internet.

### Required infrastructure

All provisioned by the compose stack — no external dependencies. If you
need your own DB or Redis, switch to the bare-metal path below.

### Network

The server binds `0.0.0.0:3000` inside its container but is only reachable
through Caddy (no other service publishes ports). `/health` and `/metrics`
remain loopback-only at the app layer, so Caddy forwards them nowhere.

## Deploy from source (bare-metal, no Docker)

If you can't run Docker in the target environment, Echo still ships as a
straight Node.js app. You'll need to provision PostgreSQL, Redis, and
SearXNG yourself.

```bash
git clone https://github.com/Banald/echo.git
cd echo
nvm use                # picks up Node 24 from .nvmrc
npm ci --omit=dev
npm run build          # tsc → dist/

cp .env.example .env
# Uncomment the "Bare-metal only" block and fill in DATABASE_URL, REDIS_URL,
# SEARXNG_URL, API_KEY_HMAC_SECRET. Set NODE_ENV=production, PORT, BIND_HOST,
# PUBLIC_HOST, ALLOWED_ORIGINS.

# Migrations + first key
node --env-file=.env dist/db/migrate.js up
node --env-file=.env dist/cli/keys.js create --name "production"

# SearXNG still runs in Docker — it's the simplest way to ship it
docker compose up -d searxng

# PM2 supervises both node processes
pm2 start ecosystem.config.cjs
pm2 save
```

Required infrastructure for bare-metal:

- PostgreSQL 14+
- Redis 7+ (rate limiting and cache; no special eviction policy required)
- SearXNG via `docker compose up -d searxng` (config lives in `infra/searxng/`)
- A reverse proxy you provision yourself (nginx, Caddy, HAProxy, …) that
  terminates TLS, sets `X-Forwarded-*` headers, and forwards only `/mcp`
  externally. `/health` and `/metrics` are loopback-only by design.

The server binds `127.0.0.1` by default in this mode — keep it that way and
rely on the reverse proxy as the ingress boundary.

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
