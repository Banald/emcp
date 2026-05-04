# Changelog

All notable changes to eMCP land here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and eMCP follows [Semantic Versioning](https://semver.org/).

## [2.5.0]

### Added

- `python-execute` MCP tool — runs caller-supplied Python in a fresh, network-isolated podman container per invocation, with bounded memory / PID / CPU caps and a per-call tmpfs at `/tmp`. Targets data wrangling, scientific computation (numpy / pandas / scipy / sympy / matplotlib / scikit-learn), and plotting — the use cases the calculator can't reach. User code is piped via stdin (never on argv); wall-clock timeout is enforced from Node and the container is killed by name on timeout. Every failure surfaces as `isError`; the tool never throws. Codified in `docs/SECURITY.md` Rule 15.
- `ghcr.io/banald/python-sandbox` released image — the sandbox runtime, built from `infra/python-sandbox/Dockerfile` and signed with the same cosign keyless identity as the eMCP image. Pushed to GHCR with the same semver tag set on every release. `install.sh` pulls it automatically after the stack is healthy.
- `image-scan-sandbox` CI job — applies the same Trivy gate (HIGH/CRITICAL, ignore-unfixed, shared `.trivyignore`) to the sandbox image as the existing `image-scan` does for the eMCP image.
- `bash scripts/build-python-sandbox.sh` (also exposed as `npm run sandbox:build`) — local-build path for the sandbox image. Used by the install-time fallback when the GHCR pull fails (air-gapped hosts, registry hiccups, bootstrap before the first release).
- `EMCP_PYTHON_SANDBOX_RUNTIME` and `EMCP_PYTHON_SANDBOX_IMAGE` env vars — operator overrides for the runtime (`podman` default; `docker` accepted) and image reference. Defaults to the released ghcr.io tag matching the installer version.

### Changed

- `install.sh` and `scripts/preflight-rootless.sh` now require `podman` alongside the existing rootless docker daemon. Distro-specific remediation prints for Debian / Ubuntu, Fedora / RHEL, Arch, Alpine. `EMCP_SKIP_PODMAN_CHECK=1` (symmetric to `EMCP_SKIP_ROOTLESS_CHECK`) bypasses for hosts that don't intend to use python-execute. The installer is still fully rootless and runs no `sudo` itself — every `sudo` reference is inside printed remediation strings for the operator's one-time package install.
- `install.sh` runs a new `phase_pull_python_sandbox` after the stack is healthy. Pulls the version-pinned sandbox image from GHCR; falls back to a local build via `scripts/build-python-sandbox.sh` on failure. Wired into `phase_reconfigure` too so `emcp config` after an upgrade picks up the new tag.
- `EMCP_PYTHON_SANDBOX_{RUNTIME,IMAGE}` are written into the managed `.env` block and listed in `EMCP_MANAGED_ENV_KEYS`, so reconfigure preserves operator overrides without dropping or duplicating them.
- CI's `ci`, `ci-rootless`, and the matching `ci` job in `release.yml` all install podman + build the sandbox image before tests, so the python-execute test gate exercises real network/fs isolation rather than mocked argv shape.

## [2.4.0]

### Changed

- The repo is now public, so `install.sh` no longer authenticates to `ghcr.io`. The `phase_ghcr_login` step (manifest probe, `gh` CLI fallback, manual PAT prompt) was removed; first-run installs and `emcp config` re-runs no longer ask for a token.

### Removed

- `--ghcr-token-file` flag and `GHCR_TOKEN` environment variable — both were only meaningful while the package registry required `read:packages`. CI that supplied either can drop the flag/env var; passing `--ghcr-token-file` now fails with `unknown flag`.

## [2.3.0]

### Added

- `calculator` tool — a single MCP tool covering arithmetic, lightweight algebra, numerical calculus, linear algebra, statistics & probability (descriptive + Pearson + OLS + normal/binomial/poisson/uniform PDF/CDF/Inv), trigonometry, unit conversion (13 categories, NIST/BIPM/IAU/CODATA-anchored), financial math (interest, NPV, IRR, PMT, amortization), and complex numbers. Driven by a hand-rolled bounded expression parser (no `eval`); flat input schema with a `mode` discriminator and per-mode optional fields. Zero new dependencies.

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
