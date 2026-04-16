# Operations

This document covers operational tasks: managing API keys, running migrations, graceful shutdown, and observability endpoints. Read it when modifying CLI tooling, the migration system, the shutdown sequence, or `/health` / `/metrics`.

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

Both the server process and worker processes handle `SIGTERM` and `SIGINT` with a coordinated shutdown sequence. PM2 sends `SIGINT` first, then `SIGKILL` after `kill_timeout`.

### Server shutdown sequence

1. **Stop accepting new requests** — HTTP server's `listen` loop closes, returns 503 with `Connection: close` for any in-flight TCP accept.
2. **Drain SSE connections** — for active stateful sessions with open SSE streams, send a `notifications/cancelled` event and close the stream.
3. **Wait for in-flight tool calls** — abort their `ctx.signal` and wait up to `SHUTDOWN_TIMEOUT_MS / 2` for them to complete.
4. **Close the Postgres pool** — `pool.end()`. Existing queries finish; new queries throw.
5. **Close Redis connections** — `redis.quit()` (graceful) with a 2s fallback to `redis.disconnect()` (hard).
6. **Flush logs** — `pino.flush()` ensures buffered logs reach the transport.
7. **Exit 0.**

If the entire sequence exceeds `SHUTDOWN_TIMEOUT_MS` (default 30s), force-exit with code 1. PM2 will restart.

### Worker shutdown sequence

1. **Stop pulling new jobs** — `worker.close()` waits for in-flight jobs.
2. **In-flight jobs** receive an abort signal. They should checkpoint or fail gracefully — BullMQ will retry per the queue's policy.
3. **Wait up to `SHUTDOWN_TIMEOUT_MS` (default 60s for workers)** for in-flight jobs to finish.
4. **Close Postgres + Redis connections.**
5. **Flush logs, exit 0.**

### Implementation pattern

A shared `src/lib/shutdown.ts` exposes `registerShutdown(handler)`. The handler returns a promise; shutdown runs all registered handlers in reverse registration order (LIFO — last registered, first shut down). This naturally aligns dependencies: queues registered after the DB are closed before the DB.

```typescript
import { registerShutdown } from './lib/shutdown.ts';

registerShutdown(async () => {
  logger.info('closing http server');
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});
```

### Rules

- Every long-lived resource (HTTP server, DB pool, Redis client, BullMQ Worker, Queue) MUST register a shutdown handler when it's created.
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
| `mcp_requests_total` | counter | `tool`, `status` | Request count per tool, success/error |
| `mcp_request_duration_seconds` | histogram | `tool` | Per-tool latency distribution |
| `mcp_request_bytes_in` | histogram | `tool` | Request size distribution |
| `mcp_request_bytes_out` | histogram | `tool` | Response size distribution |
| `mcp_active_sessions` | gauge | — | Currently open Streamable HTTP sessions |
| `mcp_auth_failures_total` | counter | `reason` | Auth failures by category (missing, invalid, blacklisted, deleted, rate-limited) |
| `mcp_rate_limit_hits_total` | counter | `scope` | Rate limit triggers (`per_key`, `per_tool`) |
| `bullmq_jobs_total` | counter | `queue`, `status` | Job lifecycle counters |
| `bullmq_job_duration_seconds` | histogram | `queue` | Job processing duration |
| `bullmq_queue_depth` | gauge | `queue`, `state` | Current jobs by state (waiting, active, delayed, failed) |


### Rules

- **Never label by API key ID.** High cardinality breaks Prometheus. Aggregate auth failures by reason, not by key.
- **Never label by user input.** Tool names are bounded (the registered set); user-supplied strings are not.
- New metrics need a brief comment explaining why aggregate observability requires them.
- Endpoint binds to loopback only — same as `/health`.

## Backup considerations (deferred)

Postgres backups, Redis persistence policy, log retention — these are deployment-environment concerns out of scope for this codebase. Document the chosen policy in your deployment runbook (separate repo). The application requires only:

- Postgres: standard ACID, no special requirements.
- Redis: `maxmemory-policy noeviction` (mandatory for BullMQ), AOF persistence with 1s fsync recommended.
