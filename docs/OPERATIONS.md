# Operations

This document covers operational tasks: managing API keys, running migrations, graceful shutdown, and observability endpoints. Read it when modifying CLI tooling, the migration system, the shutdown sequence, or `/health` / `/metrics`.

## The `emcp` command (preferred entry point)

Hosts provisioned by `scripts/install.sh` have `/usr/local/bin/emcp`, a
thin wrapper around `docker compose` in the install directory (default
`/opt/emcp`). Every operation in this document can be driven through it,
and `emcp key …` is a full passthrough to the `keys.ts` subcommands
documented below. The raw `docker compose run …` forms remain supported
and are the escape hatch when the wrapper doesn't fit.

`emcp help` prints the full command list at runtime. Source of truth is
`scripts/emcp` — the tables below are the same list, with the equivalent
raw compose invocation spelled out.

### Lifecycle

| Task | `emcp` form | Equivalent raw form |
|--|--|--|
| Start the stack | `emcp up` | `docker compose up -d` |
| Stop the stack | `emcp down` | `docker compose down` |
| Stop + wipe volumes (destructive) | `emcp down -v` | `docker compose down -v` |
| Restart all services | `emcp restart` | `docker compose restart` |
| Restart named services | `emcp restart <svc…>` | `docker compose restart <svc…>` |
| Status | `emcp status` (alias `emcp ps`) | `docker compose ps` |
| Show installer + image-tag versions | `emcp version` | n/a (reads `install.sh` + `.env`) |

### Observability

| Task | `emcp` form | Equivalent raw form |
|--|--|--|
| Tail all service logs (follow, last 100) | `emcp logs` (alias `emcp log`) | `docker compose logs -f --tail 100` |
| Tail one service | `emcp logs <svc>` | `docker compose logs -f --tail 100 <svc>` |
| One-shot `/health` probe | `emcp health` | `docker compose exec mcp-server node -e 'fetch("http://127.0.0.1:3000/health")…'` |

### Data

| Task | `emcp` form | Equivalent raw form |
|--|--|--|
| Apply pending migrations | `emcp migrate` | `docker compose run --rm migrate` |
| Migration status | `emcp migrate status` | `docker compose run --rm migrate node dist/db/migrate.js status` |
| Roll back N migrations | `emcp migrate down <n>` | `docker compose run --rm migrate node dist/db/migrate.js down <n>` |

### API keys (passthrough to `keys.ts`)

| Task | `emcp` form |
|--|--|
| Create | `emcp key create --name "..." [--rate-limit N] [--allow-no-origin]` |
| List | `emcp key list [--status active\|blacklisted\|deleted\|all]` |
| Show | `emcp key show <id-or-prefix>` |
| Blacklist | `emcp key blacklist <id-or-prefix> [--reason "..."] [--yes]` |
| Unblacklist | `emcp key unblacklist <id-or-prefix> [--yes]` |
| Soft-delete | `emcp key delete <id-or-prefix> [--yes]` |
| Set rate limit | `emcp key set-rate-limit <id-or-prefix> <per-minute>` |

Every flag documented in the [API key management (CLI)](#api-key-management-cli)
section below works here too — `emcp key <cmd> <args>` is a transparent
passthrough to `docker compose run --rm mcp-server node dist/cli/keys.js <cmd> <args>`.

### Maintenance

| Task | `emcp` form | Equivalent raw form |
|--|--|--|
| Pull current pinned image and recreate | `emcp update` | `docker compose pull && docker compose up -d` |
| Pin a specific tag and update | `emcp update <tag>` (alias `emcp upgrade <tag>`) | edit `EMCP_IMAGE_TAG` in `.env`, then `docker compose pull && docker compose up -d` |
| Re-run the interactive env wizard | `emcp config` | edit `.env` by hand, `docker compose up -d` |
| Uninstall (destroys data) | `emcp uninstall` | `docker compose down -v && rm -rf /opt/emcp` |
| Print help | `emcp help` (aliases `--help` / `-h`; bare `emcp` with no args) | n/a |
| Print version | `emcp version` (aliases `--version` / `-V`) | n/a |

`emcp` resolves the install directory from `/etc/emcp/config` (written by
`install.sh`) and falls back to `/opt/emcp`. Override per-invocation with
`EMCP_HOME=/alt/path emcp …`.

## API key management (CLI)

API keys are managed via a CLI script at `src/cli/keys.ts`, run with `node --env-file=.env src/cli/keys.ts <command>`. There is **no admin HTTP endpoint** — managing keys requires shell access to the host. This eliminates an entire class of attack surface.

### Commands

```bash
# Create a new key. Prints the raw key ONCE — store it immediately.
node --env-file=.env src/cli/keys.ts create --name "Production CI" [--rate-limit 120] [--allow-no-origin]

# List all keys (prefixes only, never raw values)
node --env-file=.env src/cli/keys.ts list [--status active|blacklisted|deleted|all]

# Show details and metrics for a single key (by id or prefix)
node --env-file=.env src/cli/keys.ts show <id-or-prefix>

# Blacklist a key (rejects future requests, preserves history)
node --env-file=.env src/cli/keys.ts blacklist <id-or-prefix> [--reason "..."]

# Unblacklist (restores 'active' status)
node --env-file=.env src/cli/keys.ts unblacklist <id-or-prefix>

# Soft-delete (rejects future requests, never recoverable as 'active')
node --env-file=.env src/cli/keys.ts delete <id-or-prefix>

# Update rate limit
node --env-file=.env src/cli/keys.ts set-rate-limit <id-or-prefix> <per-minute>
```

### Output rules

- **`create` is the only command that prints the raw key.** It prints once, to stdout, with a clear "save this now, it will not be shown again" warning. The CLI process exits immediately after.
- All other commands show the prefix only.
- All commands write a structured audit log entry (separate from operational logs) recording who ran what, when, against which key.
- Exit codes: `0` success, `1` not found, `2` validation error, `3` config/connection error.

### Safety

- The CLI uses the same `src/lib/errors.ts` and config validation as the server — misconfigured environments fail loudly here too.
- All mutations are wrapped in a Postgres transaction.
- `delete` and `blacklist` prompt for interactive confirmation by default. Pass `--yes` to skip (for scripted use).
- The CLI never prints the HMAC pepper, full DB connection string, or any other secret.

### Implementation notes for future modifications

- Subcommands live in `src/cli/keys/<command>.ts` for testability — each is a pure function taking parsed args + a `Repo` interface.
- `src/cli/keys.ts` is a thin dispatcher (parse argv → route → call subcommand → format output).
- Use `node:util.parseArgs` for argument parsing — no `commander`/`yargs` dependency.
- Tests live alongside subcommands and mock the repository.

## Database migrations

Migrations live in `migrations/` and are managed by `node-pg-migrate`. Filenames are timestamp-prefixed so order is deterministic.

### Creating a migration

```bash
npx node-pg-migrate create <descriptive-name> --migration-file-language sql
# Creates migrations/1734567890123_descriptive-name.sql
```

The file contains two sections, both required:

```sql
-- Up Migration
CREATE TABLE example (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

-- Down Migration
DROP TABLE example;
```

### Running migrations

```bash
# Apply all pending migrations
node --env-file=.env src/db/migrate.ts up

# Roll back the most recent migration
node --env-file=.env src/db/migrate.ts down

# Roll back N migrations
node --env-file=.env src/db/migrate.ts down <n>

# Show migration status
node --env-file=.env src/db/migrate.ts status
```

`src/db/migrate.ts` is a thin wrapper around `node-pg-migrate`'s programmatic API that uses our existing `pg.Pool` configuration.

### Rules

- **Every migration MUST have a working `Down` section.** Untested rollbacks are not allowed. CI runs `up` then `down` then `up` on a fresh test database to verify reversibility.
- **Never edit a migration after it has been applied to any non-local environment.** Create a new migration to fix issues.
- **Schema-breaking changes need a multi-step migration**: add new column → backfill → cut over reads → cut over writes → drop old column. Each step is its own migration.
- **Long-running migrations** (large table rewrites, index builds): use Postgres concurrent operations (`CREATE INDEX CONCURRENTLY`) and be aware that node-pg-migrate runs each migration in a transaction — concurrent operations require `--no-transaction` in the migration metadata.
- **No application code in migrations.** Pure SQL. If logic is needed, write a one-off script in `src/db/scripts/` and document it.
- **Test the migration** before committing: apply against a Testcontainer Postgres instance with realistic data volume.

### CI behavior

CI runs migrations against a fresh Postgres container at the start of integration tests. A migration failure aborts the build. The reversibility check (up → down → up) runs as a separate CI step and also blocks merges.

## Graceful shutdown

Both the server process and worker processes handle `SIGTERM` and `SIGINT` with a coordinated shutdown sequence. Docker Compose sends `SIGTERM` on `docker compose stop`, then `SIGKILL` after `stop_grace_period`. PM2 on bare-metal sends `SIGINT` first, then `SIGKILL` after `kill_timeout`. Both paths are wired to the same budgets: 35s for the server (`EMCP_SHUTDOWN_TIMEOUT_MS` + 5s) and 65s for the worker.

### Server shutdown sequence

1. **Stop accepting new requests** — HTTP server's `listen` loop closes, returns 503 with `Connection: close` for any in-flight TCP accept.
2. **Drain SSE connections** — for active stateful sessions with open SSE streams, send a `notifications/cancelled` event and close the stream.
3. **Wait for in-flight tool calls** — abort their `ctx.signal` and wait up to `EMCP_SHUTDOWN_TIMEOUT_MS / 2` for them to complete.
4. **Close the Postgres pool** — `pool.end()`. Existing queries finish; new queries throw.
5. **Close Redis connections** — `redis.quit()` (graceful) with a 2s fallback to `redis.disconnect()` (hard).
6. **Flush logs** — `pino.flush()` ensures buffered logs reach the transport.
7. **Exit 0.**

If the entire sequence exceeds `EMCP_SHUTDOWN_TIMEOUT_MS` (default 30s), force-exit with code 1. The supervisor (Docker Compose or PM2) will restart per its `restart` / `autorestart` policy.

### Worker shutdown sequence

1. **Stop the cron scheduler** — every cron handle stops; no new ticks fire. `stopped = true`, so even if a late callback slips through it is dropped.
2. **Abort in-flight runs** — the shared shutdown `AbortSignal` fires, so any handler honoring `ctx.signal` (all of them, please) aborts cleanly.
3. **Wait up to `EMCP_SHUTDOWN_TIMEOUT_MS` (default 30s)** for in-flight runs to settle. The scheduler polls `inFlight` every 50ms until drained or the grace timeout elapses.
4. **Close the Postgres pool.**
5. **Flush logs, exit 0.**

If a handler ignores the signal and blocks past the grace window, the scheduler returns anyway and the process proceeds to exit. The supervisor's grace window — Docker Compose `stop_grace_period: 65s` or PM2 `kill_timeout: 65000` — gives ample margin.

### Implementation pattern

A shared `src/lib/shutdown.ts` exposes `registerShutdown(handler)`. The handler returns a promise; shutdown runs all registered handlers in reverse registration order (LIFO — last registered, first shut down). This naturally aligns dependencies: consumers of a resource register after it and therefore close before it (e.g. the worker scheduler registers after the DB pool, so the scheduler stops and drains before the pool closes).

```typescript
import { registerShutdown } from './lib/shutdown.ts';

registerShutdown(async () => {
  logger.info('closing http server');
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});
```

### Rules

- Every long-lived resource (HTTP server, DB pool, Redis client, worker scheduler) MUST register a shutdown handler when it's created.
- Shutdown handlers MUST be idempotent — they may be called twice on a force-exit path.
- Shutdown handlers MUST NOT throw; catch internally and log.
- Test critical shutdown paths in integration tests by sending `SIGTERM` to a child process and asserting clean exit.

## Health endpoint

`GET /health` returns liveness and readiness in one response.

```json
{
  "status": "ok",
  "version": "1.2.3",
  "uptime_s": 3600,
  "checks": {
    "db": { "status": "ok", "latency_ms": 2 },
    "redis": { "status": "ok", "latency_ms": 1 }
  }
}
```

- HTTP 200 when all checks pass.
- HTTP 503 when any check fails. Body still returns the JSON above with the failed check's `status: "fail"` and an `error` field.
- Checks have a 1-second timeout each; a hung dependency is a failure.
- Endpoint binds to loopback only — it must NOT be exposed externally. The reverse proxy whitelists external paths (`/mcp` only) and forwards `/health` only to internal monitoring.

## Metrics endpoint

`GET /metrics` exposes Prometheus text format via `prom-client`. Standard collectors (process, GC, event loop) plus custom metrics.

### Standard metrics (auto-collected)

- `process_cpu_*`, `process_resident_memory_bytes`
- `nodejs_eventloop_lag_seconds`
- `nodejs_active_handles`, `nodejs_active_requests`
- `nodejs_gc_*`

### Custom metrics

| Metric | Type | Labels | Purpose |
|--|--|--|--|
| `mcp_requests_total` | counter | `tool`, `status` | Request count per tool. `status` ∈ `success`, `error`, `rate_limited`, `aborted_shutdown`. |
| `mcp_request_duration_seconds` | histogram | `tool` | Per-tool latency distribution |
| `mcp_request_bytes_in` | histogram | `tool` | Request size distribution |
| `mcp_request_bytes_out` | histogram | `tool` | Response size distribution |
| `mcp_active_sessions` | gauge | — | Currently open Streamable HTTP sessions |
| `mcp_auth_failures_total` | counter | `reason` | Auth failures by category (missing, invalid, blacklisted, deleted, rate-limited) |
| `mcp_rate_limit_hits_total` | counter | `scope` | Rate limit triggers (`per_key`, `per_tool`) |
| `worker_runs_total` | counter | `worker`, `status` | Worker run lifecycle. `status` ∈ `success`, `failure`, `timeout`, `skipped_overlap`. |
| `worker_run_duration_seconds` | histogram | `worker` | Duration of `success`/`failure`/`timeout` runs. |


### Rules

- **Never label by API key ID.** High cardinality breaks Prometheus. Aggregate auth failures by reason, not by key.
- **Never label by user input.** Tool names are bounded (the registered set); user-supplied strings are not.
- New metrics need a brief comment explaining why aggregate observability requires them.
- Endpoint binds to loopback only — same as `/health`.

## Containerized deployment operations

When eMCP runs under Docker Compose (see `README.md`), every CLI command
runs via `docker compose run --rm <service>`. The image is the same one
that powers `mcp-server` and `mcp-worker` — it ships `dist/db/migrate.js`,
`dist/cli/keys.js`, and the full runtime.

### Applying migrations

```bash
docker compose run --rm migrate
# Equivalent to: node dist/db/migrate.js up
```

Other migration commands target the same service with an explicit override:

```bash
docker compose run --rm migrate node dist/db/migrate.js status
docker compose run --rm migrate node dist/db/migrate.js down 1
```

The `migrate` service also runs automatically on `docker compose up` (as a
one-shot `restart: "no"` dependency of `mcp-server` and `mcp-worker`).

### Managing API keys

```bash
docker compose run --rm mcp-server node dist/cli/keys.js create --name "..."
docker compose run --rm mcp-server node dist/cli/keys.js list
docker compose run --rm mcp-server node dist/cli/keys.js blacklist <id-or-prefix>
```

Use `mcp-server` rather than `mcp-worker` — the image is identical but the
server service is wired with Postgres access in its env.

### Health and metrics access

`/health` and `/metrics` bind to loopback inside the server container and
are blocked at the Caddy edge. To inspect them:

```bash
docker compose exec mcp-server \
  node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.text()).then(console.log)"
```

Or scrape metrics from the host:

```bash
docker compose exec mcp-server \
  node -e "fetch('http://127.0.0.1:3000/metrics').then(r=>r.text()).then(console.log)"
```

For Prometheus scraping, run the scraper as another compose service on the
same compose network and point it at `mcp-server:3000/metrics` — but
**do not publish those ports on Caddy**. That would defeat the loopback
check.

### Secrets rotation

See `secrets/README.md` for the inventory. Rotation procedure:

1. Replace the file contents in `secrets/`.
2. `docker compose restart <affected-services>`.

Rotating `api_key_hmac_secret.txt` invalidates every existing API key —
coordinate a re-hash before rotating. Rotating `redis_password.txt` is a
simple bounce (see `secrets/README.md`) — losing the rate-limit cache
during the restart has no durability consequence.

### Graceful restarts

```bash
docker compose restart mcp-server   # 35s grace period (= EMCP_SHUTDOWN_TIMEOUT_MS + 5s)
docker compose restart mcp-worker   # 65s grace period (allows long cron handlers to drain)
```

The grace periods are configured via `stop_grace_period` in `compose.yaml`
and mirror the PM2 `kill_timeout` values in `ecosystem.config.cjs`.

## Outbound proxy rotation

eMCP can rotate external HTTP egress across a configurable pool of HTTP(S) proxies. When `EMCP_PROXY_URLS` is empty (the default), every external fetch goes direct and the subsystem is effectively absent. When it's set, the server + worker processes pick a proxy per request, retry on connect failure, and cool down misbehaving proxies automatically.

Subsystem deep-dive lives in `docs/ARCHITECTURE.md` ("Proxy egress") and `docs/SECURITY.md` Rule 13. This section is the operator runbook.

### Turning the feature on

The installer's `phase_proxy_wizard` is the happy path:

```bash
# Interactive: the wizard asks whether to enable, collects URLs, validates each.
sudo bash install.sh                         # fresh install
emcp config                                  # existing install

# Non-interactive: CSV + rotation + SearXNG proxies all supplied.
sudo bash install.sh --non-interactive \
  --public-host emcp.example.com --public-scheme https \
  --allowed-origins https://emcp.example.com \
  --proxy-urls "http://user:pass@p1.example.com:8080,http://user:pass@p2.example.com:8080" \
  --proxy-rotation round-robin \
  --searxng-proxies "http://user:pass@p1.example.com:8080,http://user:pass@p2.example.com:8080"
```

To turn it off later, either `emcp config` → decline the proxy prompt, or edit `/opt/emcp/.env` and clear `EMCP_PROXY_URLS=` (and `EMCP_SEARXNG_OUTGOING_PROXIES=`), then `emcp restart`.

Operator-facing prints mask the credentials (`http://***@host:port`). The raw `.env` file is written at `0600` and the credentials never appear in `docker compose logs`.

### Knobs

Set in `/opt/emcp/.env`; compose rebuilds on `emcp restart`:

| Variable | Default | Purpose |
|--|--|--|
| `EMCP_PROXY_URLS` | empty | Comma-separated proxy pool. Empty disables everything. |
| `EMCP_PROXY_ROTATION` | `round-robin` | `round-robin` or `random`. |
| `EMCP_PROXY_FAILURE_COOLDOWN_MS` | `60000` | How long a failed proxy stays out of rotation (1 s – 1 h). |
| `EMCP_PROXY_MAX_RETRIES_PER_REQUEST` | `3` | Failover budget per request; clamped to pool size at runtime. |
| `EMCP_PROXY_CONNECT_TIMEOUT_MS` | `10000` | CONNECT handshake timeout (1 s – 60 s). |
| `EMCP_SEARXNG_OUTGOING_PROXIES` | empty | Proxies SearXNG engines rotate through. Independent of `EMCP_PROXY_URLS`. |

### Observing

All counters live on the server's `/metrics` endpoint (loopback-only; scrape from inside the container):

```bash
docker compose exec mcp-server \
  node -e "fetch('http://127.0.0.1:3000/metrics').then(r=>r.text()).then(console.log)" \
  | grep -E '^proxy_'
```

Expected metrics:

- `proxy_requests_total{proxy_id="p0",status="success"}` — running total of successful hops per proxy. Label `status` ∈ `success | connect_failure | upstream_failure | aborted`.
- `proxy_request_duration_seconds{proxy_id="p0"}` — histogram of per-attempt latency.
- `proxy_cooldowns_total{proxy_id="p0"}` — every time a proxy transitioned into cooldown.
- `proxy_pool_healthy` — current rotation-eligible count. Drops below pool size when proxies are cooled down.

The `proxy_id` label is the pool index (`p0`, `p1`, …); the URL is never labelled (cardinality + credentials).

### Common scenarios

**A proxy is consistently failing.** Check `proxy_cooldowns_total{proxy_id="pN"}` and the corresponding `proxy_requests_total{proxy_id="pN",status="connect_failure"}`. If one proxy dominates, take it out of the rotation by editing `EMCP_PROXY_URLS` and running `emcp restart`. The worker's in-progress runs will complete on whatever the pool gave them; new runs pick up the trimmed list.

**The whole upstream is slow.** Latency histograms rise for every proxy equally. `proxy_pool_healthy` stays at pool size. This is upstream (not proxy) trouble — escalate to the upstream provider.

**Blacklist event.** Expect `proxy_requests_total{status="upstream_failure"}` to spike on one proxy as the upstream starts returning 407/502/429 through the CONNECT. The proxy enters cooldown for `EMCP_PROXY_FAILURE_COOLDOWN_MS`; traffic shifts to the rest of the pool for that window. If the block is sticky (longer than the cooldown), operator intervention is expected: replace the blacklisted proxy in `.env`, `emcp restart`.

**SearXNG can't reach upstreams.** `EMCP_SEARXNG_OUTGOING_PROXIES` is rendered into `settings.yml` by `infra/searxng/entrypoint.sh` at container start. If the operator configures a bogus URL, SearXNG logs the rendering failure mode clearly:

```bash
docker compose logs searxng | head -5
# [emcp-searxng] proxies enabled: p1.example.com:8080,p2.example.com:8080
docker compose exec searxng grep -A4 'outgoing:' /etc/searxng/settings.yml
```

Toggle SearXNG back to direct by setting `EMCP_SEARXNG_OUTGOING_PROXIES=` and `emcp restart`.

**Rotating credentials on a proxy.** Edit `EMCP_PROXY_URLS` in `.env` (replace the `user:pass@` segment), `emcp restart`. The server + worker reload the pool at startup; no other step. Old `ProxyAgent` instances are closed via the shutdown registry on graceful restart.

### Known limitations

- **HTTP + HTTPS proxies only.** SOCKS5 is not supported in v1 (see `docs/SECURITY.md` Rule 13 for rationale).
- **No per-tool proxy routing.** The pool is global; every tool and the fetch-news worker share the same rotation. If a specific tool should egress differently, that's a code change (introducing a secondary pool) and is out of scope for the current design.
- **No health probing.** The pool learns about proxy failures lazily — from real requests. A freshly-down proxy won't be detected until the next request lands on it, at which point the cooldown path fires. If this turns into a problem in practice, a probing worker is a natural follow-up.
- **Single-process rotation state.** Server and worker each own a pool instance. That's fine because their request streams are independent; the scale-out constraint is the same as the rest of the worker process (`instances: 1`).

## Backup considerations (deferred)

Postgres backups, Redis persistence policy, log retention — these are deployment-environment concerns out of scope for this codebase. Document the chosen policy in your deployment runbook (separate repo). The application requires only:

- Postgres: standard ACID, no special requirements.
- Redis: used only for rate-limit sliding windows and ad-hoc caching. No special eviction policy required; `allkeys-lru` is a reasonable default. Persistence is optional — losing the rate-limit cache has no durability consequence.
