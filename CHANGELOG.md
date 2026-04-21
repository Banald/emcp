# Changelog

All notable changes to eMCP land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and eMCP follows [Semantic Versioning](https://semver.org/).

## [2.2.0]

### Added

- `get-current-context` tool — returns the server's current UTC datetime, a training-cutoff hint, and a short list of reminders to nudge the model away from reasoning on stale training data. Zero-arg; intended to be called at the start of a session before anything time-sensitive.

## [2.1.0]

### Changed

- `get-weather` accepts a place name instead of raw coordinates and returns a compact snapshot rather than the full MET Norway forecast series. Tool descriptions for `fetch-url` and `web-search` tightened to read better for LLM callers.
- `README.md` refactored as the human entry point; deeper operational content moved into `docs/`.

### Removed

- Tools `wikipedia-get`, `wikipedia-search`, `riksdag-search`, `scb-query`, `dictionary`, and `arxiv-search` — low-signal or niche surface trimmed from the default toolset.

## [2.0.1]

### Fixed

- `scripts/preflight-rootless.sh`: every failed check now prints a distro-aware, multi-step bootstrap (deps → install rootless Docker → enable user-mode daemon → export `DOCKER_HOST`) instead of single-line hints that assumed rootless Docker was already installed. Per-distro coverage for Debian / Ubuntu / Mint / Pop!_OS, Fedora / RHEL / Rocky / Alma, Arch / Manjaro, and Alpine; generic fallback for everything else.
- `check_docker_daemon` now distinguishes "no daemon at all", "installed but not started" (detected via `~/.config/systemd/user/docker.service`), "daemon unreachable", and "rootful daemon" — each gets a tailored remediation.
- `check_subid_ranges` now offers both modern (`usermod --add-subuids`) and legacy (`tee -a /etc/subuid`) paths so older shadow-utils hosts get a working command.
- `check_apparmor_userns` reformatted as an explicit quick-vs-correct two-option block.

## [2.0.0] — Rootless by default, OWASP-aligned

### Summary

v2 ships eMCP as a rootless-first deployment. The installer and every `emcp …` subcommand run as an unprivileged user; the entire stack lives under the operator's own rootless Docker daemon. Every service in `compose.yaml` now measurably meets the [OWASP Docker Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Docker_Security_Cheat_Sheet.html) rules #1, #3, #4, #5, #7, #8, #9, #11, and #13.

### Breaking changes

- **No sudo anywhere at runtime.** The installer refuses to run as root; `emcp config` and `emcp uninstall` dropped their `exec sudo` branches; `phase_ghcr_login` dropped its `SUDO_USER` fallback.
- **Install paths move to XDG user directories.**

  | Before | After |
  |---|---|
  | `/opt/emcp` | `${XDG_DATA_HOME:-$HOME/.local/share}/emcp` |
  | `/etc/emcp/config` | `${XDG_CONFIG_HOME:-$HOME/.config}/emcp/config` |
  | `/usr/local/bin/emcp` | `${XDG_BIN_HOME:-$HOME/.local/bin}/emcp` |

- **Default host ports are now 8080 / 8443** (rootless Docker cannot publish <1024 without a one-time `sudo setcap`). Caddy still binds internal :80/:443. Three documented options for public :80/:443 service: operator-owned front-proxy, one-time setcap, or DNS-01 ACME.
- **`EMCP_ALLOWED_ORIGINS` default now includes the chosen host port** so the browser CORS preflight works against `localhost:8443` out of the box.

### Added

- `scripts/preflight-rootless.sh` — read-only preflight that checks kernel ≥ 5.13, uidmap / slirp4netns / dbus-user-session packages, `/etc/subuid`+`/etc/subgid` range ≥ 65536 for the operator, systemd linger, `kernel.apparmor_restrict_unprivileged_userns` (the Ubuntu 23.10+/24.04 default that blocks rootlesskit), and that `docker info` reports the `rootless` SecurityOption. Prints per-distro remediation commands for each failed check.
- `compose.yaml` service-level hardening:
  - `security_opt: [no-new-privileges:true]` on every service (OWASP #4).
  - `cap_drop: [ALL]` on every service + minimal per-service `cap_add` (OWASP #3).
  - `read_only: true` + targeted `tmpfs` overlays (OWASP #8).
  - Per-service `mem_limit`, `pids_limit`, `cpus`, `ulimits.nofile` (OWASP #7).
  - Two named networks — `emcp_internal` (app plane, egress allowed) and `emcp_data` (`internal: true`, no egress). Postgres + Redis attach to `emcp_data` only; app services dual-home (OWASP #5).
- `Dockerfile` runtime stage strips the bundled `npm`, `npx`, and `corepack` — the entrypoint is `node dist/...` and never invokes them. Removes OWASP #8 attack surface and the transitive CVEs that came with npm's own dependency tree (e.g. CVE-2026-33671 in npm's `picomatch`).
- `Dockerfile` base image pinned by sha256 digest in every stage (OWASP #13). `.github/dependabot.yml` grows a `package-ecosystem: docker` entry to track the digest.
- `.github/workflows/ci.yml`:
  - New `image-scan` job — Trivy scans the built runtime image and fails on CRITICAL / HIGH CVEs (OWASP #9). `.trivyignore` is checked in empty.
  - New `ci-rootless` job — installs rootless Docker on the GHA runner and runs the end-to-end install test.
- `.github/workflows/release.yml`:
  - SBOM + SLSA provenance attestations already on the Buildx step.
  - **Keyless cosign signing** via the workflow's OIDC identity. Release notes include a ready-to-run `cosign verify` invocation.
- `tests/e2e/install-rootless.test.sh` — end-to-end check that the installer runs with zero sudo invocations against a real rootless daemon, and that every running container matches the declared OWASP posture.
- Updated `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/OPERATIONS.md`, `README.md` for the rootless + OWASP story.

### Changed

- Installer `--help` rewritten to reflect the new paths and ports.
- `.env.example` documents the new port defaults, the three public-port options, and every `EMCP_<SVC>_MEM_LIMIT/PIDS_LIMIT/CPUS` tunable.
- `infra/searxng/entrypoint.sh` reads the template from `/usr/local/share/emcp-searxng/settings.template.yml` (the prior `/etc/searxng` path is now tmpfs and would shadow the bind mount).

### Removed

- System paths `/opt/emcp`, `/etc/emcp/config`, `/usr/local/bin/emcp`.
- `exec sudo` branches in `scripts/emcp` (cmd_config, cmd_uninstall).
- `SUDO_USER` re-run logic in `phase_ghcr_login`.

### OWASP compliance matrix

| Rule | Status |
|---|---|
| #0 Keep host + Docker up to date | preflight warns on kernel < 5.13; README prescribes host updates |
| #1 Do not expose Docker daemon socket | enforced — `install.test.sh` asserts compose.yaml never references docker.sock |
| #2 Set a user | `USER emcp` (uid 10001); caddy runs as root inside userns-remapped subuid |
| #3 Limit capabilities | `cap_drop: [ALL]` on every service; minimal `cap_add` per service |
| #4 No new privileges | `security_opt: [no-new-privileges:true]` on every service |
| #5 Inter-container connectivity | data plane `internal: true`; no egress from postgres/redis |
| #5a Port mapping + firewalls | rootless uses slirp4netns; no iptables bypass |
| #6 LSMs | Docker's default seccomp + host AppArmor; `install.test.sh` forbids `unconfined` |
| #7 Limit resources | mem_limit, pids_limit, cpus, ulimits.nofile on every service |
| #8 Read-only FS + tmpfs | `read_only: true` on every service; per-service tmpfs list; `npm`/`npx`/`corepack` stripped from the runtime image |
| #9 Scan images in CI | Trivy gate in ci.yml + release.yml |
| #10 Daemon log level = info | operator-owned; no code change |
| #11 Run Docker rootless | enforced — preflight refuses to proceed against rootful |
| #12 Docker secrets | postgres, redis, and HMAC pepper via compose `secrets:` |
| #13 Supply chain | base image digest-pinned; SBOM + provenance + keyless cosign signing |
