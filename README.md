# Echo

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

## Quick install

The fastest way to run Echo on a Linux host with Docker:

```bash
curl -fsSL https://github.com/Banald/echo/releases/latest/download/install.sh | sudo bash
```

Or, to inspect before running (recommended):

```bash
curl -fsSL https://github.com/Banald/echo/releases/latest/download/install.sh -o install.sh
less install.sh
sudo bash install.sh
```

The installer:

- checks prerequisites (Docker 24+, Compose v2, daemon running, free disk)
- downloads the matched-release source tarball into `/opt/echo`
- generates the three Docker secrets (`postgres_password.txt`,
  `redis_password.txt`, `api_key_hmac_secret.txt`)
- walks you through `.env` with plain-English prompts
- **optionally enables outbound proxy rotation** — if SearXNG's engines
  or upstream APIs rate-limit you by IP, say yes to the proxy wizard
  and paste a comma-separated list of `http://user:pass@host:port`
  URLs. Server + worker + SearXNG all rotate across the list with
  transparent failover. Full details in
  [`docs/OPERATIONS.md`](./docs/OPERATIONS.md#outbound-proxy-rotation).
- logs in to `ghcr.io` (via `gh` CLI if available, or a pasted PAT)
- brings the stack up and waits for health
- detects common failures (port already in use, stale `pgdata` volume
  with mismatched password) and offers a remediation
- installs the `emcp` command at `/usr/local/bin/emcp` for day-2 ops
- creates your first API key (optional, interactive)

Non-interactive install (for CI / automation):

```bash
sudo GHCR_TOKEN="$PAT" bash install.sh \
  --non-interactive \
  --public-host echo.example.com --public-scheme https \
  --allowed-origins https://echo.example.com \
  --skip-first-key
```

See `scripts/install.sh --help` for all flags.

### Day-2 commands: `emcp`

Once installed, drive the stack with `emcp` from anywhere — no `cd` into
the compose directory, no long `docker compose run …` recitations:

```bash
emcp status                               # show container status
emcp logs                                 # tail all services
emcp logs mcp-server                      # tail one
emcp key create --name "my-client"        # issue an API key
emcp key list
emcp key delete <id-or-prefix>
emcp migrate                              # apply pending migrations
emcp restart                              # restart the stack
emcp update                               # pull latest image tag, recreate
emcp update v0.12.0                       # pin a specific tag
emcp down                                 # stop (preserves data)
emcp config                               # re-run the env wizard
emcp uninstall                            # stop + remove everything (destroys data)
emcp help                                 # full command list
```

`emcp key …` is a transparent passthrough to the bundled
[`keys.ts` CLI](./docs/OPERATIONS.md#api-key-management-cli) — any
subcommand documented there works, including `show`, `blacklist`,
`unblacklist`, and `set-rate-limit`.

### TLS

Controlled by `PUBLIC_SCHEME` in `.env` (default `https`). The installer
sets this for you; you can change it later with `emcp config` or by
editing `/opt/echo/.env` directly and running `emcp restart`.

**HTTPS mode (`PUBLIC_SCHEME=https`, default).** Caddy picks a strategy
based on `PUBLIC_HOST`:

- `localhost`, `127.0.0.1`, or an IP literal → internal CA (self-signed).
  Trust once with `caddy trust` if you want browsers to stop warning.
- A real public hostname → Let's Encrypt. Requires DNS A/AAAA pointing at
  the host and ports 80/443 reachable from the internet.
- An internal-only hostname (e.g. `host.corp.local`) needs `tls internal`
  in `infra/caddy/Caddyfile.https` — Let's Encrypt can't validate it.

**HTTP mode (`PUBLIC_SCHEME=http`).** Caddy serves plaintext on port 80
with TLS fully disabled. Intended for deployments on trusted internal
networks. Caveats:

- Bearer tokens on `/mcp` travel in the clear — anyone on-path can read
  them. Do not use across untrusted networks.
- Update `ALLOWED_ORIGINS` to include the `http://` origin clients will
  send.

Switching modes is a restart, not a rebuild: `emcp config` → pick the new
scheme, or edit `/opt/echo/.env` and `emcp restart`.

## Advanced / manual deploy

The installer above is a thin wrapper around `docker compose`. If you
prefer to drive compose yourself — forking, iterating on the image
locally, or placing the install in a non-standard path — here's the
manual recipe:

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
openssl rand -base64 24 > secrets/redis_password.txt
openssl rand -base64 32 > secrets/api_key_hmac_secret.txt
# 0644 (not 0600): Compose `secrets:` bind-mounts these files into the
# container with host permissions preserved, and the non-root container
# user (UID 10001) must be able to read them. See secrets/README.md.
chmod 0644 secrets/*.txt

# 3. Authenticate to ghcr.io
# Banald/echo is private, so pulling the image requires auth. If gh CLI
# is already signed in, extend your token with `read:packages` once and
# pipe it straight into docker login:
gh auth refresh -s read:packages   # one-time per machine
gh auth token | docker login ghcr.io -u "$(gh api user -q .login)" --password-stdin
# No gh CLI? Create a classic PAT with `read:packages` at
# https://github.com/settings/tokens/new?scopes=read:packages and:
#   echo "$GHCR_PAT" | docker login ghcr.io -u <your-github-username> --password-stdin

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
`docker compose up`. To apply pending migrations without touching the
rest:

```bash
docker compose run --rm migrate
```

### Pinning a specific version

By default compose pulls `ghcr.io/banald/echo:latest`. To pin a release
tag (recommended for production), set in `.env`:

```
ECHO_IMAGE_TAG=v0.5.1
ECHO_PULL_POLICY=always
```

Then `docker compose pull && docker compose up -d` to refresh. If the
`emcp` CLI is installed, `emcp update v0.5.1` does the same.

### Building from source instead of pulling

If you've forked the repo, or you're iterating on the image locally, skip
the ghcr.io login and build from source instead:

```
ECHO_PULL_POLICY=build
```

in `.env`. First `up -d` will build the image from the working tree.

### Required infrastructure

All provisioned by the compose stack — no external dependencies. If you
need your own DB or Redis, switch to the bare-metal path below.

### Network

The server binds `0.0.0.0:3000` inside its container but is only
reachable through Caddy (no other service publishes ports). `/health`
and `/metrics` remain loopback-only at the app layer, so Caddy forwards
them nowhere.

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
