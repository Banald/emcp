# mcp-server

Production-grade MCP server in TypeScript. Streamable HTTP transport, API key authentication with usage metrics, BullMQ-backed background workers, drop-in tool authoring.

## Stack

Node.js 24 LTS · TypeScript · PostgreSQL · Redis · BullMQ · Pino · Prometheus

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

# Run server + worker (two terminals)
npm run dev
npm run dev:worker
```

## Project layout

See [`AGENTS.md`](./AGENTS.md) for the full project context. Quick map:

- `src/tools/` — drop a `.ts` file per tool. See [`docs/TOOL_AUTHORING.md`](./docs/TOOL_AUTHORING.md).
- `src/workers/processors/` — background job processors. See [`docs/WORKER_AUTHORING.md`](./docs/WORKER_AUTHORING.md).
- `src/cli/keys.ts` — API key management. See [`docs/OPERATIONS.md`](./docs/OPERATIONS.md).
- `migrations/` — SQL migrations.

## Running in production

Build:
```bash
npm run build
```

Process management with PM2:
```bash
pm2 start ecosystem.config.cjs
pm2 save
```

The server binds to `127.0.0.1` by default. Front it with a reverse proxy (nginx, Caddy) that handles TLS, sets `X-Forwarded-*` headers, and forwards only `/mcp` externally. `/health` and `/metrics` are loopback-only by design.

Required infrastructure:

- PostgreSQL 14+
- Redis 7+ with `maxmemory-policy noeviction` (BullMQ requirement; corruption otherwise)

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
