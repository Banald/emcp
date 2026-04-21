# eMCP

[![CI](https://github.com/Banald/emcp/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Banald/emcp/actions/workflows/ci.yml)
[![Release](https://github.com/Banald/emcp/actions/workflows/release.yml/badge.svg)](https://github.com/Banald/emcp/actions/workflows/release.yml)
[![Node.js](https://img.shields.io/badge/node-24%20LTS-5FA04E)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/platform-Linux%20%C2%B7%20Rootless%20Docker-0db7ed)](docs/INSTALL.md)

Production-grade Model Context Protocol server in TypeScript. Streamable HTTP transport, API-key authentication with per-key usage metrics, drop-in scheduled workers, and a rootless-first Docker Compose stack hardened against the [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html).

eMCP runs end-to-end as an unprivileged user against your own rootless Docker daemon — no host root, no exposure of `/var/run/docker.sock`. Authentication, rate limiting, Prometheus metrics, a migration runner, and a cron scheduler ship in the box.

## Features

- **Streamable HTTP transport** at `/mcp` with stateful sessions and server-initiated notifications.
- **API-key authentication** — HMAC-SHA256 hashing with a server-side pepper, per-key rate limits, per-key usage metrics, soft-delete and blacklist lifecycle.
- **Drop-in tool authoring** — one `.ts` file per tool in `src/tools/`, discovered at startup. No manifest, no registry.
- **Drop-in scheduled workers** — croner-backed cron in a separate process, one `.ts` file per worker.
- **Optional outbound proxy rotation** with transparent failover for SearXNG engines and upstream APIs.
- **Prometheus `/metrics`** and loopback-only `/health`.
- **OWASP-aligned compose stack** — non-root containers, `cap_drop: [ALL]`, read-only root filesystems, image signing (cosign keyless), SBOM + SLSA provenance.

## Install

On a Linux host with rootless Docker already set up:

```bash
curl -fsSL https://github.com/Banald/emcp/releases/latest/download/install.sh | bash
```

Prefer to inspect first:

```bash
curl -fsSL https://github.com/Banald/emcp/releases/latest/download/install.sh -o install.sh
less install.sh
bash install.sh
```

The installer runs entirely as your unprivileged user. It validates every rootless precondition, generates the three Docker secrets, walks you through `.env`, brings the stack up, and installs the `emcp` CLI at `$HOME/.local/bin/emcp` for day-2 operations.

### Requirements

- Linux with a rootless Docker daemon (kernel ≥ 5.13, `uidmap`, `slirp4netns`, `dbus-user-session`).
- Docker 24+, Compose v2.
- Subuid / subgid range ≥ 65536 for your user; `loginctl enable-linger`.

If rootless Docker isn't set up yet, the installer's preflight prints the exact bootstrap commands. Full bootstrap, alternative install paths (manual Docker Compose, bare-metal), TLS modes, and public-port options are in [`docs/INSTALL.md`](docs/INSTALL.md).

## Day-2 operations

```bash
emcp up                           # start the stack
emcp status                       # container status
emcp logs                         # tail all services
emcp key create --name "client"   # issue an API key (shown once — save it)
emcp migrate                      # apply pending migrations
emcp update                       # pull current tag, recreate
emcp help                         # full command list
```

Full command reference in [`docs/INSTALL.md`](docs/INSTALL.md#day-2-commands-emcp). API key CLI details in [`docs/OPERATIONS.md`](docs/OPERATIONS.md#api-key-management-cli).

## Documentation

| Topic | Document |
|---|---|
| Install, deploy, day-2 CLI | [`docs/INSTALL.md`](docs/INSTALL.md) |
| Architecture, schema, env vars, dependencies | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Security rules and audit checklist | [`docs/SECURITY.md`](docs/SECURITY.md) |
| API keys, migrations, shutdown, metrics, proxy runbook | [`docs/OPERATIONS.md`](docs/OPERATIONS.md) |
| Adding an MCP tool | [`docs/TOOL_AUTHORING.md`](docs/TOOL_AUTHORING.md) |
| Adding a scheduled worker | [`docs/WORKER_AUTHORING.md`](docs/WORKER_AUTHORING.md) |
| Testing patterns and the coverage gate | [`docs/TESTING.md`](docs/TESTING.md) |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |

Contributing, or an AI agent catching up on the project? Start with [`AGENTS.md`](AGENTS.md) — it is the source of truth for how to work in this repository. An orientation map of `docs/` lives at [`docs/README.md`](docs/README.md).
