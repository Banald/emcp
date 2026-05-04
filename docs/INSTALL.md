# Install

This document is the full install and deployment guide for eMCP. The root [`README.md`](../README.md) has the one-command quickstart; read this when you need the rootless bootstrap, a manual Docker Compose install, a bare-metal install, alternate port / TLS choices, or the full `emcp` day-2 reference.

## Contents

- [Quick install](#quick-install)
- [First-time rootless Docker setup](#first-time-rootless-docker-setup)
  - [Happy-path bootstrap](#happy-path-bootstrap)
  - [Ubuntu 23.10+ / 24.04 — AppArmor restriction](#ubuntu-2310--2404--apparmor-restriction)
  - [Confirm the preflight is green](#confirm-the-preflight-is-green)
- [What the installer does](#what-the-installer-does)
- [Non-interactive install](#non-interactive-install)
- [Day-2 commands: `emcp`](#day-2-commands-emcp)
- [Public port binding in rootless mode](#public-port-binding-in-rootless-mode)
- [TLS](#tls)
- [Manual Docker Compose install](#manual-docker-compose-install)
- [Pinning a specific version](#pinning-a-specific-version)
- [Building from source instead of pulling](#building-from-source-instead-of-pulling)
- [Bare-metal install (no Docker)](#bare-metal-install-no-docker)
- [Verifying the image signature](#verifying-the-image-signature-cosign-keyless)

## Quick install

On a Linux host with **rootless Docker** already set up:

```bash
curl -fsSL https://github.com/Banald/emcp/releases/latest/download/install.sh | bash
```

To inspect before running (recommended):

```bash
curl -fsSL https://github.com/Banald/emcp/releases/latest/download/install.sh -o install.sh
less install.sh
bash install.sh
```

If rootless Docker isn't set up yet, the installer's preflight prints the exact remediation commands. The next section walks the full bootstrap end-to-end.

## First-time rootless Docker setup

eMCP refuses to install against a rootful daemon. `scripts/preflight-rootless.sh` prints the exact remediation for any missing precondition and is what the installer runs first. The commands below are the one-time setup you'll need on a fresh host.

### Happy-path bootstrap

On a fresh Ubuntu / Debian host:

```bash
# One-time package install — the last time you'll use sudo at runtime.
# `podman` is required by the python-execute MCP tool (see docs/SECURITY.md
# Rule 15). After install.sh runs, the released python-sandbox image is
# pulled automatically via `podman pull ghcr.io/banald/python-sandbox:vX.Y.Z`
# (signed with the same cosign keyless identity as the eMCP image). Set
# EMCP_SKIP_PODMAN_CHECK=1 to install without podman if you don't intend to
# use python-execute.
sudo apt install -y uidmap slirp4netns dbus-user-session fuse-overlayfs podman

# Subordinate UID/GID range (skip if `grep "^$USER:" /etc/subuid` already shows
# a range >= 65536 — Ubuntu seeds one automatically for useradd).
sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 "$USER"

# Rootless daemon survives logout.
sudo loginctl enable-linger "$USER"

# Install + start the rootless daemon as the current user.
curl -fsSL https://get.docker.com/rootless | sh
systemctl --user enable --now docker

# Point the docker CLI at the user daemon for subsequent shells (add to .bashrc).
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/docker.sock
export PATH=$HOME/bin:$PATH
```

After that, `bash install.sh` runs sudo-free from start to finish.

### Ubuntu 23.10+ / 24.04 — AppArmor restriction

Ubuntu 23.10 introduced `kernel.apparmor_restrict_unprivileged_userns=1` as the default, which blocks `rootlesskit` from `fork/exec`-ing `/proc/self/exe`. The symptom is a clear error at daemon start:

```
[rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: permission denied
```

Two fixes:

1. **Quick sysctl disable** (trusted hosts — opens a kernel feature you may have wanted off):

   ```bash
   echo 'kernel.apparmor_restrict_unprivileged_userns=0' \
     | sudo tee /etc/sysctl.d/60-rootless-docker.conf
   sudo sysctl --system
   ```

2. **Per-binary AppArmor profile** (correct long-term fix):

   ```bash
   sudo tee /etc/apparmor.d/home.${USER}.bin.rootlesskit > /dev/null <<EOT
   abi <abi/4.0>,
   include <tunables/global>

   $HOME/bin/rootlesskit flags=(unconfined) {
     userns,
     include if exists <local/home.${USER}.bin.rootlesskit>
   }
   EOT
   sudo systemctl restart apparmor.service
   ```

`scripts/preflight-rootless.sh` flags this automatically (`check_apparmor_userns`). See the upstream notes at <https://rootlesscontaine.rs/getting-started/common/#apparmor>.

### Confirm the preflight is green

```bash
bash scripts/preflight-rootless.sh
```

Expect every line to be `[ok]`. Then run the installer — no sudo from here on.

## What the installer does

`install.sh` is a thin wrapper around `docker compose`. End-to-end, it:

- runs `scripts/preflight-rootless.sh` — verifies kernel ≥ 5.13, `uidmap` / `slirp4netns` / `dbus-user-session` packages, `/etc/subuid` + `/etc/subgid` range ≥ 65536 for `$USER`, `loginctl enable-linger`, and that `docker info` reports the `rootless` SecurityOption. Prints the exact remediation command for every failing check.
- checks prerequisites (Docker 24+, Compose v2, free disk).
- downloads the matched-release source tarball into `${XDG_DATA_HOME:-$HOME/.local/share}/emcp`.
- generates the three Docker secrets (`postgres_password.txt`, `redis_password.txt`, `api_key_hmac_secret.txt`).
- walks you through `.env` with plain-English prompts.
- **optionally enables outbound proxy rotation** — if SearXNG's engines or upstream APIs rate-limit you by IP, accept the proxy wizard and paste a comma-separated list of `http://user:pass@host:port` URLs. Server + worker + SearXNG all rotate across the list with transparent failover. Full details in [`OPERATIONS.md`](OPERATIONS.md#outbound-proxy-rotation).
- brings the stack up and waits for health.
- detects common failures (port already in use, stale `pgdata` volume with mismatched password) and offers a remediation.
- installs the `emcp` command at `${XDG_BIN_HOME:-$HOME/.local/bin}/emcp` for day-2 ops (warns if that directory isn't on your `$PATH`).
- creates your first API key (optional, interactive).

## Non-interactive install

For CI / automation:

```bash
bash install.sh \
  --non-interactive \
  --public-host emcp.example.com --public-scheme https \
  --allowed-origins https://emcp.example.com \
  --skip-first-key
```

See `scripts/install.sh --help` for the full flag list.

## Day-2 commands: `emcp`

Once installed, drive the stack with `emcp` from anywhere — no `cd` into the compose directory, no long `docker compose run …` recitations:

```bash
# Lifecycle
emcp up                                   # start the stack (docker compose up -d)
emcp down                                 # stop (preserves data)
emcp down -v                              # stop + wipe volumes (destroys data)
emcp restart                              # restart all services
emcp restart mcp-server                   # restart a single service
emcp status                               # show container status  (alias: emcp ps)
emcp version                              # installer + image tag currently running

# Observability
emcp logs                                 # tail all services, follow, last 100 lines
emcp logs mcp-server                      # tail one                (alias: emcp log)
emcp health                               # one-shot /health probe via the server container

# Data
emcp migrate                              # apply pending migrations
emcp migrate status                       # show migration status
emcp migrate down 1                       # roll back the most recent migration

# API keys — passthrough to the bundled keys.ts CLI
emcp key create --name "my-client"        # issue an API key (shown once — save it)
emcp key list                             # list all keys (prefixes only)
emcp key list --status active             # filter: active | blacklisted | deleted | all
emcp key show <id-or-prefix>              # details and metrics for one key
emcp key blacklist <id-or-prefix>         # reject future requests, preserve history
emcp key unblacklist <id-or-prefix>
emcp key delete <id-or-prefix>            # soft-delete (never recoverable as active)
emcp key set-rate-limit <id-or-prefix> 120

# Maintenance
emcp update                               # pull the current image tag, recreate
emcp update v0.13.2                       # pin a specific tag in .env, then pull
emcp config                               # re-run the env wizard (inc. proxy prompts)
emcp uninstall                            # stop + remove everything (destroys data)
emcp help                                 # full command list with aliases
```

`emcp key …` is a transparent passthrough to the bundled [`keys.ts` CLI](OPERATIONS.md#api-key-management-cli) — every subcommand and flag documented there works here too.

`emcp` resolves the install directory from `${XDG_CONFIG_HOME:-$HOME/.config}/emcp/config` (written by `install.sh`) and falls back to `${XDG_DATA_HOME:-$HOME/.local/share}/emcp`. Override per-invocation with `EMCP_HOME=/alt/path emcp …`.

## Public port binding in rootless mode

Rootless Docker cannot publish host ports `<1024` by default. eMCP therefore defaults to `EMCP_HTTP_PORT=8080` and `EMCP_HTTPS_PORT=8443`. Caddy still binds `:80` and `:443` **inside** the container, so only the host-side publish port is affected. Three ways to serve public `:80` / `:443` anyway:

1. **Front-proxy (default, recommended).** Keep 8080/8443 and run nginx / HAProxy / your existing ingress on 80/443, forwarding to those ports. Zero rootless friction.
2. **One-time setcap.** Run `sudo setcap cap_net_bind_service=+ep $(readlink -f $(which rootlesskit))`. Afterwards rootless can publish privileged ports; set `EMCP_HTTP_PORT=80` and `EMCP_HTTPS_PORT=443` in `.env` and `emcp restart`.
3. **DNS-01 ACME.** Switch Caddy to DNS-based TLS validation using a DNS provider token. Port 80 is no longer needed on the internet; public clients reach you over 443 exclusively, which you publish via option 1 or 2.

## TLS

Controlled by `EMCP_PUBLIC_SCHEME` in `.env` (default `https`). The installer sets this for you; you can change it later with `emcp config` or by editing `$EMCP_HOME/.env` directly (default `${XDG_DATA_HOME:-$HOME/.local/share}/emcp/.env`) and running `emcp restart`.

**HTTPS mode (`EMCP_PUBLIC_SCHEME=https`, default).** Caddy picks a strategy based on `EMCP_PUBLIC_HOST`:

- `localhost`, `127.0.0.1`, or an IP literal → internal CA (self-signed). Trust once with `caddy trust` if you want browsers to stop warning.
- A real public hostname → Let's Encrypt. Requires DNS A/AAAA pointing at the host and ports 80/443 reachable from the internet.
- An internal-only hostname (e.g. `host.corp.local`) needs `tls internal` in `infra/caddy/Caddyfile.https` — Let's Encrypt can't validate it.

**HTTP mode (`EMCP_PUBLIC_SCHEME=http`).** Caddy serves plaintext on port 80 with TLS fully disabled. Intended for deployments on trusted internal networks. Caveats:

- Bearer tokens on `/mcp` travel in the clear — anyone on-path can read them. Do not use across untrusted networks.
- Update `EMCP_ALLOWED_ORIGINS` to include the `http://` origin clients will send.

Switching modes is a restart, not a rebuild: `emcp config` → pick the new scheme, or edit `$EMCP_HOME/.env` and `emcp restart`.

## Manual Docker Compose install

If you prefer to drive compose yourself — forking, iterating on the image locally, or placing the install in a non-standard path — here's the manual recipe:

```bash
git clone https://github.com/Banald/emcp.git
cd emcp

# 1. Configure
cp .env.example .env
# Edit .env — at minimum set EMCP_PUBLIC_HOST and EMCP_ALLOWED_ORIGINS.
# Change EMCP_SEARXNG_SECRET to a fresh value.

# 2. Create Docker secrets
mkdir -p secrets
openssl rand -base64 24 > secrets/postgres_password.txt
openssl rand -base64 24 > secrets/redis_password.txt
openssl rand -base64 32 > secrets/api_key_hmac_secret.txt
# 0644 (not 0600): Compose `secrets:` bind-mounts these files into the
# container with host permissions preserved, and the non-root container
# user (UID 10001) must be able to read them. See secrets/README.md.
chmod 0644 secrets/*.txt

# 3. Bring up the stack (pulls the prebuilt image from ghcr.io — the repo
#    is public, no docker login required; builds from source if
#    EMCP_PULL_POLICY=build is set in .env)
docker compose up -d

# 4. Create your first API key
docker compose run --rm mcp-server node dist/cli/keys.js create --name "production"
# Save the printed key — it will not be shown again.

# 5. Tail logs
docker compose logs -f mcp-server mcp-worker
```

Migrations run automatically via a one-shot `migrate` service on every `docker compose up`. To apply pending migrations without touching the rest:

```bash
docker compose run --rm migrate
```

### Required infrastructure

All provisioned by the compose stack — no external dependencies. If you need your own DB or Redis, switch to the bare-metal path below.

### Network

The server binds `0.0.0.0:3000` inside its container but is only reachable through Caddy (no other service publishes ports). `/health` and `/metrics` remain loopback-only at the app layer, so Caddy forwards them nowhere.

## Pinning a specific version

By default compose pulls `ghcr.io/banald/emcp:latest`. To pin a release tag (recommended for production), set in `.env`:

```
EMCP_IMAGE_TAG=v0.5.1
EMCP_PULL_POLICY=always
```

Then `docker compose pull && docker compose up -d` to refresh. If the `emcp` CLI is installed, `emcp update v0.5.1` does the same.

## Building from source instead of pulling

If you've forked the repo, or you're iterating on the image locally, build from source instead of pulling the published image:

```
EMCP_PULL_POLICY=build
```

in `.env`. First `up -d` will build the image from the working tree.

## Bare-metal install (no Docker)

If you can't run Docker in the target environment, eMCP still ships as a straight Node.js app. You'll need to provision PostgreSQL, Redis, and SearXNG yourself.

```bash
git clone https://github.com/Banald/emcp.git
cd emcp
nvm use                # picks up Node 24 from .nvmrc
npm ci --omit=dev
npm run build          # tsc → dist/

cp .env.example .env
# Uncomment the "Bare-metal only" block and fill in EMCP_DATABASE_URL,
# EMCP_REDIS_URL, EMCP_SEARXNG_URL, EMCP_API_KEY_HMAC_SECRET. Set
# NODE_ENV=production, EMCP_PORT, EMCP_BIND_HOST, EMCP_PUBLIC_HOST,
# EMCP_ALLOWED_ORIGINS.

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
- A reverse proxy you provision yourself (nginx, Caddy, HAProxy, …) that terminates TLS, sets `X-Forwarded-*` headers, and forwards only `/mcp` externally. `/health` and `/metrics` are loopback-only by design.

The server binds `127.0.0.1` by default in this mode — keep it that way and rely on the reverse proxy as the ingress boundary.

## Verifying the image signature (cosign keyless)

Every release image is signed with the release workflow's OIDC identity (OWASP Docker Cheat Sheet rule #13). Consumers verify:

```bash
cosign verify ghcr.io/banald/emcp:v2.0.0 \
  --certificate-identity-regexp '^https://github.com/Banald/emcp/\.github/workflows/release\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

SBOM and SLSA provenance attestations are attached to the image manifest:

```bash
docker buildx imagetools inspect ghcr.io/banald/emcp:v2.0.0 --format '{{ json .SBOM }}'
docker buildx imagetools inspect ghcr.io/banald/emcp:v2.0.0 --format '{{ json .Provenance }}'
```
