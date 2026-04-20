# Migrating from v1 to v2

> **Status:** eMCP did not have a public v1 release. If you bootstrapped from the v1 branch internally, this document records the three behavioral changes you'll see on upgrade. If you're a fresh v2 install, skip this page — [README.md](../README.md) is your start.

## The three breaking changes

### 1. The installer and `emcp` no longer use `sudo`

v1 required `sudo bash install.sh` and `emcp config` / `emcp uninstall` exec'd into `sudo` internally. v2 is the opposite: the installer **refuses** to run as root, and every `emcp …` subcommand runs as the current user against their own rootless Docker daemon.

Bootstrap steps that do require a one-time `sudo` (package installs, `/etc/subuid` entries, `loginctl enable-linger`) are surfaced by `scripts/preflight-rootless.sh` with the exact commands to run — we don't hide them.

### 2. Install paths moved to XDG user directories

| v1 | v2 |
|---|---|
| `/opt/emcp` | `${XDG_DATA_HOME:-$HOME/.local/share}/emcp` |
| `/etc/emcp/config` | `${XDG_CONFIG_HOME:-$HOME/.config}/emcp/config` |
| `/usr/local/bin/emcp` | `${XDG_BIN_HOME:-$HOME/.local/bin}/emcp` |

A v1 install is left alone on upgrade. If you want to recover the Postgres volume from a v1 deployment:

```bash
# On the v1 host, still running:
sudo docker compose -f /opt/emcp/compose.yaml exec postgres pg_dump -U mcp mcp > emcp-v1.sql

# Install v2 (no sudo), then restore:
bash install.sh --non-interactive --skip-first-key --no-proxy
emcp up
cat emcp-v1.sql \
  | docker compose -f "$XDG_DATA_HOME/emcp/compose.yaml" exec -T postgres \
    psql -U mcp mcp
```

**Keep `secrets/api_key_hmac_secret.txt` across the migration** — every issued API key is HMAC-hashed against that pepper, so rotating it invalidates every key in circulation.

### 3. Default host ports are 8080 / 8443

Rootless Docker cannot bind host ports < 1024. If you were on v1's `80 / 443`, you have three documented options for v2:

1. **Default (8080/8443) + a front-proxy.** Run nginx / HAProxy on the host (or your existing ingress) listening on 80/443 and forwarding to 8080/8443. Recommended when you already have an ingress layer.
2. **One-time `sudo setcap cap_net_bind_service=+ep $(readlink -f $(which rootlesskit))`.** Lets the rootless daemon publish privileged ports. After that, set `EMCP_HTTP_PORT=80` and `EMCP_HTTPS_PORT=443` in `.env` and `emcp restart`.
3. **DNS-01 ACME.** Switch Caddy to DNS-based TLS validation via a DNS provider token; port 80 is no longer needed.

Caddy still binds `:80` and `:443` *inside* the container via `NET_BIND_SERVICE`; only the host-side publish port is affected.

## Hardening surface

On top of the three breaking changes, v2 applies a pile of OWASP-aligned hardening to every compose service: `cap_drop: [ALL]`, `security_opt: [no-new-privileges:true]`, `read_only: true` with targeted tmpfs overlays, per-service mem/pids/cpu limits, and a split data/app network topology. See the [OWASP compliance matrix](../CHANGELOG.md#owasp-compliance-matrix) in the changelog for the rule-by-rule accounting.

If your v1 deployment extended compose.yaml with local overrides, review them against the v2 scaffolding before enabling — most will "just work," but anything that assumed a writable rootfs or unrestricted capabilities needs a deliberate `cap_add` or `tmpfs` entry.

## Verify your install matches a clean v2

After installing v2, the end-to-end test is the fastest confidence check:

```bash
bash tests/e2e/install-rootless.test.sh
```

It brings the stack up, inspects every running container for the declared OWASP posture, issues an API key, and verifies `/mcp` auth with a bogus and a real bearer token. Expect `[ok]` on every line.
