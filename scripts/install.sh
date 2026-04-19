#!/usr/bin/env bash
# eMCP one-shot installer. Run `install.sh --help` for the full flag list;
# usage() below is the single source of truth so `--help` still works when
# piped via `curl | sudo bash` (where $0 is "bash", not a file path).

set -euo pipefail

# Version is stamped by .github/workflows/release.yml at tag time. The sed
# match line MUST stay exact — don't reflow.
EMCP_INSTALLER_VERSION="v0.0.0-dev"

REPO_OWNER="Banald"
REPO_NAME="emcp"
# ghcr.io path is always lowercase (see release.yml "Compute lowercased
# image name" step).
IMAGE_REPO="ghcr.io/banald/emcp"

DEFAULT_INSTALL_DIR="/opt/emcp"
EMCP_BIN_PATH="/usr/local/bin/emcp"
EMCP_CONFIG_PATH="/etc/emcp/config"
INSTALLER_SAVE_PATH_REL="bin/install.sh"  # copied into $EMCP_HOME for `emcp config`
HEALTHCHECK_TIMEOUT_SECONDS=180
MIN_FREE_GB=2

# --- Parsed flags / global state -------------------------------------------

INSTALL_DIR=""
TAG=""
EMCP_PUBLIC_HOST=""
EMCP_PUBLIC_SCHEME=""
EMCP_ALLOWED_ORIGINS=""
EMCP_HTTP_PORT=""
EMCP_HTTPS_PORT=""
EMCP_LOG_LEVEL=""
EMCP_POSTGRES_USER=""
EMCP_POSTGRES_DB=""
IMAGE_TAG=""
GHCR_TOKEN_FILE=""
SKIP_FIRST_KEY=0
NON_INTERACTIVE=0
AUTO_NON_INTERACTIVE=0  # 1 when NON_INTERACTIVE was auto-set due to no TTY
# N2: every `mktemp -d` the installer makes is tracked here; the EXIT
# trap in main() sweeps the list so interrupted runs (SIGINT, SIGTERM,
# die after tmp creation but before function-local trap RETURN) don't
# leak directories under $TMPDIR.
INSTALLER_TMP_ROOTS=()
RECONFIGURE=0
FROM_LOCAL=""
UNINSTALL=0
FORCE=0
# Proxy wizard inputs. Empty means "not yet answered"; after the wizard
# runs, EMCP_PROXY_URLS/EMCP_SEARXNG_OUTGOING_PROXIES hold the final CSV
# (possibly empty), EMCP_PROXY_ROTATION holds the strategy. NO_PROXY_FLAG=1
# short-circuits the prompt in --non-interactive mode.
EMCP_PROXY_URLS=""
EMCP_PROXY_ROTATION=""
EMCP_SEARXNG_OUTGOING_PROXIES=""
EMCP_SEARXNG_OUTGOING_PROXIES_SET=0  # 1 when the flag or existing env set it
NO_PROXY_FLAG=0

# Filled during the run
EMCP_HOME=""
IS_UPGRADE=0
EMCP_SEARXNG_SECRET_EXISTING=""

# --- Logging ---------------------------------------------------------------

if [ -t 2 ]; then
    C_RESET=$'\033[0m'
    C_RED=$'\033[1;31m'
    C_YELLOW=$'\033[1;33m'
    C_BLUE=$'\033[1;34m'
    C_CYAN=$'\033[1;36m'
    C_GREEN=$'\033[1;32m'
    C_BOLD=$'\033[1m'
else
    C_RESET="" C_RED="" C_YELLOW="" C_BLUE="" C_CYAN="" C_GREEN="" C_BOLD=""
fi

# --- Install log ----------------------------------------------------------
# Initialised from main() once $EMCP_HOME is known. Every log_* call mirrors
# its payload (ANSI stripped) to this file; run_and_log captures external
# command output too. Path is 0600 — survives in $EMCP_HOME/bin so `emcp
# config` and `emcp uninstall` can see prior runs.
INSTALL_LOG_PATH=""

strip_ansi() { sed -E $'s/\x1B\\[[0-9;]*[A-Za-z]//g'; }

log_to_file() {
    [ -n "$INSTALL_LOG_PATH" ] || return 0
    # Short-circuit if the log (or its parent) no longer exists; the
    # uninstall path rm -rf's EMCP_HOME mid-run, and a bare `>>` would
    # bypass the 2>/dev/null on the pipeline to leak a bash redirect error.
    [ -e "$INSTALL_LOG_PATH" ] || return 0
    printf '%s\n' "$*" | strip_ansi >> "$INSTALL_LOG_PATH" 2>/dev/null || true
}

log_info()  { printf '%s[info]%s  %s\n'  "$C_BLUE"   "$C_RESET" "$*" >&2; log_to_file "[info]  $*"; }
log_warn()  { printf '%s[warn]%s  %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; log_to_file "[warn]  $*"; }
log_error() { printf '%s[error]%s %s\n'  "$C_RED"    "$C_RESET" "$*" >&2; log_to_file "[error] $*"; }
log_ok()    { printf '%s[ok]%s    %s\n'  "$C_GREEN"  "$C_RESET" "$*" >&2; log_to_file "[ok]    $*"; }
log_step()  { printf '\n%s==>%s %s%s%s\n' "$C_CYAN"  "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; log_to_file "==> $*"; }

die() { log_error "$*"; exit 1; }

init_install_log() {
    [ -n "${EMCP_HOME:-}" ] || return 0
    mkdir -p "$EMCP_HOME/bin" 2>/dev/null || return 0
    local path
    path="$EMCP_HOME/bin/install-$(date -u +%Y%m%d-%H%M%S).log"
    # Use `touch` so bash's own redirect-failure error (which bypasses the
    # builtin's 2>/dev/null when `> path` fails at redirection setup) never
    # leaks past this function. If create fails, we simply skip logging.
    if ! touch "$path" 2>/dev/null; then
        return 0
    fi
    chmod 0600 "$path" 2>/dev/null || true
    INSTALL_LOG_PATH="$path"
    log_to_file "install log opened at $INSTALL_LOG_PATH"
    log_to_file "installer version: $EMCP_INSTALLER_VERSION"
}

# Run a command, mirroring its stdout+stderr to the install log (and the
# terminal). Use for compose pull/up and anything whose output matters
# for postflight diagnosis. Preserves the command's exit status.
run_and_log() {
    local desc="$1"; shift
    log_to_file "--- $desc ---"
    if [ -n "$INSTALL_LOG_PATH" ]; then
        "$@" > >(tee -a >(strip_ansi >> "$INSTALL_LOG_PATH")) 2>&1
        return "${PIPESTATUS[0]}"
    fi
    "$@"
}

# Run `docker compose ...` in $EMCP_HOME without leaking a `cd` to the caller.
compose_cd() ( cd "$EMCP_HOME" && docker compose "$@"; )

# --- Arg parsing -----------------------------------------------------------

usage() {
    cat <<'USAGE' >&2
eMCP one-shot installer.

Downloads the matched-tag source tarball, generates Docker secrets, walks
you through .env interactively, logs in to ghcr.io, brings the compose
stack up, and installs the permanent `emcp` CLI at /usr/local/bin/emcp.

USAGE:
  curl -fsSL https://github.com/Banald/emcp/releases/latest/download/install.sh | sudo bash
  # or, to inspect first:
  curl -fsSL https://github.com/Banald/emcp/releases/latest/download/install.sh -o install.sh
  less install.sh
  sudo bash install.sh

FLAGS (all optional — the interactive wizard fills the gaps):
  --install-dir <path>     default: /opt/emcp
  --tag <ref>              override the release tag (default: stamped
                           installer version; rejected for dev builds)
  --public-host <host>     hostname clients will use to reach eMCP
  --public-scheme <s>      https (default) | http
  --allowed-origins <csv>  Origin allowlist, comma-separated
  --http-port <n>          host port for plain HTTP (default 80)
  --https-port <n>         host port for HTTPS (default 443)
  --log-level <level>      fatal|error|warn|info|debug|trace|silent
  --postgres-user <name>   database user (default: mcp)
  --postgres-db <name>     database name (default: mcp)
  --image-tag <tag>        pin a specific ghcr.io image tag
  --ghcr-token-file <path> PAT with read:packages (env: GHCR_TOKEN)
  --skip-first-key         don't prompt to create the first API key
  --non-interactive        fail fast instead of prompting
  --reconfigure            re-run the wizard against an existing install
  --from-local <path>      use a local repo checkout as the source tree
  --uninstall              stop the stack and remove /opt/emcp
  --force                  skip confirmation prompts
  --proxy-urls <csv>       rotating-proxy pool (http/https URLs)
  --proxy-rotation <mode>  round-robin (default) | random
  --searxng-proxies <csv>  proxies SearXNG engines use (default: same)
  --no-proxy               disable proxy routing explicitly
  -h, --help               show this help and exit

See docs/OPERATIONS.md for day-2 operations via the `emcp` CLI.
USAGE
    exit "${1:-0}"
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --install-dir)      INSTALL_DIR="$2"; shift 2 ;;
            --tag)              TAG="$2"; shift 2 ;;
            --public-host)      EMCP_PUBLIC_HOST="$2"; shift 2 ;;
            --public-scheme)    EMCP_PUBLIC_SCHEME="$2"; shift 2 ;;
            --allowed-origins)  EMCP_ALLOWED_ORIGINS="$2"; shift 2 ;;
            --http-port)        EMCP_HTTP_PORT="$2"; shift 2 ;;
            --https-port)       EMCP_HTTPS_PORT="$2"; shift 2 ;;
            --log-level)        EMCP_LOG_LEVEL="$2"; shift 2 ;;
            --postgres-user)    EMCP_POSTGRES_USER="$2"; shift 2 ;;
            --postgres-db)      EMCP_POSTGRES_DB="$2"; shift 2 ;;
            --image-tag)        IMAGE_TAG="$2"; shift 2 ;;
            --ghcr-token-file)  GHCR_TOKEN_FILE="$2"; shift 2 ;;
            --skip-first-key)   SKIP_FIRST_KEY=1; shift ;;
            --non-interactive)  NON_INTERACTIVE=1; shift ;;
            --reconfigure)      RECONFIGURE=1; shift ;;
            --from-local)       FROM_LOCAL="$2"; shift 2 ;;
            --uninstall)        UNINSTALL=1; shift ;;
            --force)            FORCE=1; shift ;;
            --proxy-urls)       EMCP_PROXY_URLS="$2"; shift 2 ;;
            --proxy-rotation)   EMCP_PROXY_ROTATION="$2"; shift 2 ;;
            --searxng-proxies)
                EMCP_SEARXNG_OUTGOING_PROXIES="$2"
                EMCP_SEARXNG_OUTGOING_PROXIES_SET=1
                shift 2 ;;
            --no-proxy)         NO_PROXY_FLAG=1; shift ;;
            -h|--help)          usage 0 ;;
            *) die "unknown flag: $1 (try --help)" ;;
        esac
    done

    INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
    EMCP_HOME="$INSTALL_DIR"

    # N1: reject combinations that don't make sense. main()'s uninstall
    # branch short-circuits before reconfigure anyway, but asking the user
    # to clarify is friendlier than a silent precedence.
    if [ "$UNINSTALL" -eq 1 ] && [ "$RECONFIGURE" -eq 1 ]; then
        die "--uninstall and --reconfigure are mutually exclusive"
    fi
    if [ "$UNINSTALL" -eq 1 ] && [ -n "$FROM_LOCAL" ]; then
        die "--uninstall doesn't use a source tree; drop --from-local"
    fi

    if [ -z "$TAG" ]; then
        TAG="$EMCP_INSTALLER_VERSION"
    fi
    if [ "$TAG" = "v0.0.0-dev" ] && [ -z "$FROM_LOCAL" ] && [ "$RECONFIGURE" -eq 0 ] && [ "$UNINSTALL" -eq 0 ]; then
        die "this install.sh is an unstamped dev build — pass --tag <vX.Y.Z> or --from-local <path>, or download install.sh from a GitHub release."
    fi
    if [ -z "$IMAGE_TAG" ]; then
        # strip leading 'v' for image tag (ghcr.io tags are 0.11.0, not v0.11.0)
        IMAGE_TAG="${TAG#v}"
    fi
}

# --- Prompt helpers --------------------------------------------------------

# Drop-in for `read`. When stdin isn't a TTY (e.g. curl | sudo bash), route
# via /dev/tty so piped installers still prompt the operator. Returns 1
# when neither stdin nor /dev/tty is usable — the caller must then respect
# NON_INTERACTIVE/AUTO_NON_INTERACTIVE or die. `[ -r /dev/tty ]` would
# wrongly say "yes" in sessions without a controlling terminal (setsid,
# systemd service contexts, etc.) because the mode bits are world-readable
# — we actually open it to discriminate.
tty_read() {
    if [ -t 0 ]; then
        read "$@"
    elif (exec 0</dev/tty) 2>/dev/null; then
        read "$@" </dev/tty
    else
        return 1
    fi
}

# prompt VAR "Question" "default" ["validator_fn"]
prompt() {
    local __out_var="$1" __question="$2" __default="${3:-}" __validator="${4:-}"
    local __current="${!__out_var:-}"
    # If already set by flag, don't prompt.
    if [ -n "$__current" ]; then
        printf '%s %s %s[%s]%s\n' "$C_CYAN$__question$C_RESET" "=" "$C_BOLD" "$__current" "$C_RESET" >&2
        return 0
    fi
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
        if [ -n "$__default" ]; then
            printf -v "$__out_var" '%s' "$__default"
            return 0
        fi
        die "--non-interactive: $__out_var has no default and was not supplied as a flag."
    fi
    local __answer
    while true; do
        if [ -n "$__default" ]; then
            tty_read -r -p "${C_CYAN}?${C_RESET} ${__question} [${__default}]: " __answer
        else
            tty_read -r -p "${C_CYAN}?${C_RESET} ${__question}: " __answer
        fi
        __answer="${__answer:-$__default}"
        if [ -z "$__answer" ]; then
            log_warn "value required"
            continue
        fi
        if [ -n "$__validator" ] && ! "$__validator" "$__answer"; then
            continue
        fi
        printf -v "$__out_var" '%s' "$__answer"
        return 0
    done
}

prompt_yesno() {
    local __question="$1" __default="${2:-y}" __answer
    if [ "$NON_INTERACTIVE" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
        [ "$__default" = "y" ] && return 0 || return 1
    fi
    while true; do
        if [ "$__default" = "y" ]; then
            tty_read -r -p "${C_CYAN}?${C_RESET} ${__question} [Y/n]: " __answer
            __answer="${__answer:-y}"
        else
            tty_read -r -p "${C_CYAN}?${C_RESET} ${__question} [y/N]: " __answer
            __answer="${__answer:-n}"
        fi
        case "${__answer,,}" in
            y|yes) return 0 ;;
            n|no)  return 1 ;;
            *) log_warn "please answer y or n" ;;
        esac
    done
}

prompt_secret() {
    local __out_var="$1" __question="$2" __answer
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
        if [ "$AUTO_NON_INTERACTIVE" -eq 1 ]; then
            die "no TTY — $__out_var is a secret. Re-run in a real terminal, or supply --ghcr-token-file / GHCR_TOKEN."
        fi
        die "--non-interactive: $__out_var is a secret and must be supplied via --ghcr-token-file or GHCR_TOKEN."
    fi
    # `read -s` requires a terminal; tty_read routes through /dev/tty when
    # stdin is piped, so -s still works. If neither stdin nor /dev/tty is
    # readable, tty_read returns 1 and we must not echo the secret.
    if ! tty_read -r -s -p "${C_CYAN}?${C_RESET} ${__question}: " __answer; then
        printf '\n' >&2
        die "no terminal available to read $__out_var without echo"
    fi
    printf '\n' >&2
    printf -v "$__out_var" '%s' "$__answer"
}

validate_host() {
    local h="$1"
    [ "$h" = "localhost" ] && return 0
    # IPv4 dotted-quad
    if [[ "$h" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then return 0; fi
    # IPv6 literal (with or without brackets)
    if [[ "$h" =~ ^\[?[0-9a-fA-F:]+\]?$ ]]; then return 0; fi
    # RFC 1035: total <= 253 chars; each dot-separated label 1..63 chars,
    # alnum with optional internal hyphens (no leading / trailing dash).
    if [ "${#h}" -lt 1 ] || [ "${#h}" -gt 253 ]; then
        log_warn "hostname length must be 1..253 (got ${#h})"; return 1
    fi
    local IFS=. label
    for label in $h; do
        if [ -z "$label" ] || [ "${#label}" -gt 63 ]; then
            log_warn "hostname label bad length: '$label' (1..63)"; return 1
        fi
        if ! [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]]; then
            log_warn "invalid hostname label (RFC 1035): '$label'"; return 1
        fi
    done
    return 0
}
validate_scheme() { [ "$1" = "http" ] || [ "$1" = "https" ] || { log_warn "must be 'http' or 'https'"; return 1; }; }
validate_port()   { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ] || { log_warn "must be 1..65535"; return 1; }; }
validate_nonempty() { [ -n "$1" ] || { log_warn "value required"; return 1; }; }
validate_loglevel() {
    case "$1" in
        fatal|error|warn|info|debug|trace|silent) return 0 ;;
        *) log_warn "one of: fatal error warn info debug trace silent"; return 1 ;;
    esac
}

# --- Preflight -------------------------------------------------------------

phase_preflight() {
    log_step "Preflight"

    if [ "$(id -u)" -ne 0 ]; then
        die "must run as root (try: sudo bash $0 ...)"
    fi

    if [ "$(uname -s)" != "Linux" ]; then
        die "installer supports Linux only (got $(uname -s))"
    fi

    if ! command -v docker >/dev/null 2>&1; then
        log_error "docker is not installed."
        suggest_docker_install
        exit 1
    fi
    if ! docker --version >/dev/null 2>&1; then
        die "docker is installed but \`docker --version\` failed."
    fi

    if ! docker compose version >/dev/null 2>&1; then
        log_error "docker compose v2 plugin is missing."
        log_error "legacy 'docker-compose' is not supported. Install the v2 plugin:"
        log_error "  https://docs.docker.com/compose/install/linux/"
        exit 1
    fi

    # compose.yaml uses `service_completed_successfully` (compose v2.17+).
    # Older versions fail with a cryptic YAML validation error at `up` time.
    local compose_ver maj min
    compose_ver="$(docker compose version --short 2>/dev/null | sed 's/^v//')"
    if [ -z "$compose_ver" ]; then
        compose_ver="$(docker compose version 2>/dev/null \
            | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1)"
    fi
    if [ -n "$compose_ver" ]; then
        IFS=. read -r maj min _ <<< "$compose_ver"
        if [ "${maj:-0}" -lt 2 ] \
           || { [ "${maj:-0}" -eq 2 ] && [ "${min:-0}" -lt 17 ]; }; then
            die "docker compose $compose_ver is too old — eMCP needs >= 2.17 (service_completed_successfully). Upgrade: https://docs.docker.com/compose/install/"
        fi
    else
        log_warn "could not determine docker compose version; assuming it's recent enough"
    fi

    if ! docker info >/dev/null 2>&1; then
        log_error "cannot reach the Docker daemon."
        log_error "start it with: systemctl enable --now docker"
        exit 1
    fi

    # H2: CI publishes linux/amd64 only. Other arches silently fail at pull
    # or run time with `exec format error`. Warn so the operator can set
    # EMCP_PULL_POLICY=build in .env (compose builds from the Dockerfile).
    local arch; arch="$(uname -m)"
    case "$arch" in
        x86_64|amd64) : ;;
        *)
            log_warn "host arch is ${arch}; eMCP images publish linux/amd64 only. Set EMCP_PULL_POLICY=build in .env after the wizard if you want to rebuild from source." ;;
    esac

    for bin in openssl curl tar sed awk; do
        command -v "$bin" >/dev/null 2>&1 || die "missing required binary: $bin"
    done

    # Pick a data dir to check free space. Falls back to /var/lib/docker.
    local docker_root
    docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
    docker_root="${docker_root:-/var/lib/docker}"
    if [ -d "$docker_root" ]; then
        local free_gb
        free_gb="$(df -BG "$docker_root" | awk 'NR==2 {gsub(/G/, "", $4); print $4}')"
        if [ -n "$free_gb" ] && [ "$free_gb" -lt "$MIN_FREE_GB" ] 2>/dev/null; then
            log_warn "${docker_root} has only ${free_gb}G free; ${MIN_FREE_GB}G recommended."
            prompt_yesno "continue anyway?" n || die "aborted by user"
        fi
    fi

    mkdir -p "$EMCP_HOME"

    log_ok "preflight passed"
}

# Runs in a subshell so sourcing /etc/os-release (which exports many vars)
# doesn't leak into the parent. M5: also matches ID_LIKE so derivatives
# (Rocky Linux, AlmaLinux, Pop!_OS, EndeavourOS, etc.) pick the right
# suggestion even when ID itself isn't in the list.
suggest_docker_install() (
    id="" id_like=""
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        . /etc/os-release
        id="${ID:-}"
        id_like="${ID_LIKE:-}"
    fi
    haystack=" $id $id_like "
    case "$haystack" in
        *\ fedora\ *|*\ rhel\ *|*\ centos\ *|*\ rocky\ *|*\ almalinux\ *)
            log_error "install with: dnf install -y docker docker-compose-plugin" ;;
        *\ debian\ *|*\ ubuntu\ *|*\ linuxmint\ *|*\ pop\ *)
            log_error "install with: apt-get install -y docker.io docker-compose-plugin" ;;
        *\ arch\ *|*\ manjaro\ *|*\ endeavouros\ *)
            log_error "install with: pacman -S --noconfirm docker docker-compose" ;;
        *\ alpine\ *)
            log_error "install with: apk add docker docker-cli-compose" ;;
        *)
            log_error "install Docker per: https://docs.docker.com/engine/install/" ;;
    esac
)

# --- Source fetch ----------------------------------------------------------

phase_fetch_source() {
    log_step "Fetch source ($TAG)"

    if [ -f "$EMCP_HOME/compose.yaml" ]; then
        IS_UPGRADE=1
        log_info "existing install detected at $EMCP_HOME"
        if ! prompt_yesno "upgrade in place (preserve secrets and .env)?" y; then
            die "aborted by user"
        fi
    fi

    if [ -n "$FROM_LOCAL" ]; then
        [ -f "$FROM_LOCAL/compose.yaml" ] || die "--from-local: $FROM_LOCAL/compose.yaml not found"
        log_info "copying from local checkout $FROM_LOCAL → $EMCP_HOME"
        copy_source_tree "$FROM_LOCAL" "$EMCP_HOME"
        return 0
    fi

    local url="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${TAG}.tar.gz"
    local tmp
    tmp="$(mktemp -d)"
    # Register with the global EXIT trap so SIGINT mid-download also cleans
    # up. The function-local RETURN trap still fires on normal return.
    INSTALLER_TMP_ROOTS+=("$tmp")
    trap 'rm -rf "$tmp"' RETURN

    log_info "downloading $url"
    local curl_rc=0
    curl -fsSL "$url" -o "$tmp/src.tar.gz" || curl_rc=$?
    # L2: translate common curl exit codes into actionable messages.
    case "$curl_rc" in
        0) : ;;
        22) die "tag $TAG not found (HTTP 4xx from $url). See https://github.com/${REPO_OWNER}/${REPO_NAME}/releases" ;;
        6)  die "DNS lookup failed for github.com — check /etc/resolv.conf and outbound connectivity" ;;
        7)  die "connection refused reaching github.com — check your firewall or HTTP proxy" ;;
        28) die "curl timed out fetching $url — check your network latency / proxy" ;;
        *)  die "curl failed (exit $curl_rc) fetching $url" ;;
    esac

    tar -xzf "$tmp/src.tar.gz" -C "$tmp"
    local extracted
    extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -n1)"
    [ -n "$extracted" ] || die "source tarball has unexpected layout"

    copy_source_tree "$extracted" "$EMCP_HOME"
    log_ok "source extracted to $EMCP_HOME"
}

# Copy only the files compose.yaml needs, preserving existing .env + secrets.
copy_source_tree() {
    local src="$1" dst="$2"
    mkdir -p "$dst"
    local paths=(compose.yaml Dockerfile .dockerignore .env.example)
    for p in "${paths[@]}"; do
        [ -e "$src/$p" ] && cp -f "$src/$p" "$dst/$p"
    done
    for d in infra docker migrations; do
        if [ -d "$src/$d" ]; then
            rm -rf "${dst:?}/$d"
            cp -r "$src/$d" "$dst/$d"
        fi
    done
    mkdir -p "$dst/secrets"
    [ -f "$src/secrets/README.md" ] && cp -f "$src/secrets/README.md" "$dst/secrets/README.md"
}

# --- Secrets ---------------------------------------------------------------

phase_generate_secrets() {
    log_step "Generate Docker secrets"
    mkdir -p "$EMCP_HOME/secrets"

    generate_secret_if_missing "$EMCP_HOME/secrets/postgres_password.txt"   24 "postgres password"
    generate_secret_if_missing "$EMCP_HOME/secrets/redis_password.txt"      24 "redis password"

    if [ -s "$EMCP_HOME/secrets/api_key_hmac_secret.txt" ]; then
        log_info "api_key_hmac_secret.txt exists — preserving (rotating it invalidates every API key)"
    elif [ "$IS_UPGRADE" -eq 1 ]; then
        log_warn "api_key_hmac_secret.txt is missing on an upgrade. Generating a fresh one WILL invalidate every previously issued API key."
        if ! prompt_yesno "generate a new HMAC pepper and accept that all old keys will stop working?" n; then
            die "aborted; restore secrets/api_key_hmac_secret.txt from backup and re-run"
        fi
        generate_secret_if_missing "$EMCP_HOME/secrets/api_key_hmac_secret.txt" 32 "API key HMAC pepper"
    else
        generate_secret_if_missing "$EMCP_HOME/secrets/api_key_hmac_secret.txt" 32 "API key HMAC pepper"
    fi

    chmod 0644 "$EMCP_HOME/secrets"/*.txt
    log_ok "secrets ready at $EMCP_HOME/secrets/"
}

generate_secret_if_missing() {
    local path="$1" bytes="$2" label="$3"
    if [ -s "$path" ]; then
        log_info "$label exists — preserving"
        return 0
    fi
    openssl rand -base64 "$bytes" > "$path"
    chmod 0644 "$path"
    log_info "$label generated (${bytes} bytes)"
}

# --- .env wizard -----------------------------------------------------------

phase_env_wizard() {
    log_step "Configure .env"

    # Seed defaults from an existing .env so re-runs are non-destructive.
    load_existing_env_defaults

    prompt EMCP_PUBLIC_HOST "Public hostname — what clients will use to reach eMCP (e.g. emcp.example.com, or 'localhost' for local use)" "${EMCP_PUBLIC_HOST:-localhost}" validate_host

    prompt EMCP_PUBLIC_SCHEME "Use HTTPS (recommended) or HTTP? HTTP is plaintext; use only on fully trusted networks" "${EMCP_PUBLIC_SCHEME:-https}" validate_scheme

    if [ -z "$EMCP_ALLOWED_ORIGINS" ]; then
        EMCP_ALLOWED_ORIGINS="${EMCP_PUBLIC_SCHEME}://${EMCP_PUBLIC_HOST}"
        if [ "$EMCP_PUBLIC_HOST" = "localhost" ]; then
            EMCP_ALLOWED_ORIGINS="http://localhost,https://localhost"
        fi
    fi
    prompt EMCP_ALLOWED_ORIGINS "Allowed Origin header values (comma-separated, include scheme)" "$EMCP_ALLOWED_ORIGINS" validate_nonempty

    if [ -z "$EMCP_HTTP_PORT" ]; then
        EMCP_HTTP_PORT=80
        if port_in_use 80 && ! caddy_holds_port 80; then
            log_warn "port 80 is already in use on this host"
            resolve_port_conflict 80 && EMCP_HTTP_PORT=8080
        fi
    fi
    prompt EMCP_HTTP_PORT "HTTP port on the host" "$EMCP_HTTP_PORT" validate_port

    if [ -z "$EMCP_HTTPS_PORT" ]; then
        EMCP_HTTPS_PORT=443
        if [ "$EMCP_PUBLIC_SCHEME" = "https" ] \
           && port_in_use 443 && ! caddy_holds_port 443; then
            log_warn "port 443 is already in use on this host"
            resolve_port_conflict 443 && EMCP_HTTPS_PORT=8443
        fi
    fi
    prompt EMCP_HTTPS_PORT "HTTPS port on the host" "$EMCP_HTTPS_PORT" validate_port

    prompt EMCP_LOG_LEVEL "Log level — leave 'info' unless debugging" "${EMCP_LOG_LEVEL:-info}" validate_loglevel
    prompt EMCP_POSTGRES_USER "Postgres user for the mcp database" "${EMCP_POSTGRES_USER:-mcp}" validate_nonempty
    prompt EMCP_POSTGRES_DB   "Postgres database name"              "${EMCP_POSTGRES_DB:-mcp}"   validate_nonempty

    local searxng_secret="$EMCP_SEARXNG_SECRET_EXISTING"
    [ -n "$searxng_secret" ] || searxng_secret="$(openssl rand -hex 32)"

    write_env_file "$searxng_secret"
    log_ok ".env written to $EMCP_HOME/.env (0600)"

    dns_sanity_check
}

# H8: when the operator sets a real public hostname with HTTPS, Caddy's
# Let's Encrypt flow silently loops until DNS points at this host. A
# fast local check is better than a slow mystery. Warning-only — DNS may
# be set up after install (split-horizon, dry-run, etc.).
dns_sanity_check() {
    [ "${EMCP_PUBLIC_SCHEME:-https}" = "https" ] || return 0
    local h="$EMCP_PUBLIC_HOST"
    case "$h" in
        localhost|*.local) return 0 ;;
    esac
    if [[ "$h" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then return 0; fi
    if [[ "$h" =~ ^\[?[0-9a-fA-F:]+\]?$ ]]; then return 0; fi
    if ! command -v getent >/dev/null 2>&1; then
        # getent is part of glibc; should be on any supported Linux. Skip if not.
        return 0
    fi
    if ! getent hosts "$h" >/dev/null 2>&1; then
        log_warn "DNS for $h does not resolve on this host. Let's Encrypt will fail until the A/AAAA record points here. (If DNS will be wired up after install, ignore this.)"
    fi
}

load_existing_env_defaults() {
    local f="$EMCP_HOME/.env"
    [ -f "$f" ] || return 0
    # Extract known keys without sourcing (the file may contain arbitrary quoting).
    local k v
    while IFS='=' read -r k v; do
        case "$k" in
            EMCP_PUBLIC_HOST)       [ -z "$EMCP_PUBLIC_HOST" ]      && EMCP_PUBLIC_HOST="$(dequote "$v")" ;;
            EMCP_PUBLIC_SCHEME)     [ -z "$EMCP_PUBLIC_SCHEME" ]    && EMCP_PUBLIC_SCHEME="$(dequote "$v")" ;;
            EMCP_ALLOWED_ORIGINS)   [ -z "$EMCP_ALLOWED_ORIGINS" ]  && EMCP_ALLOWED_ORIGINS="$(dequote "$v")" ;;
            EMCP_HTTP_PORT)         [ -z "$EMCP_HTTP_PORT" ]        && EMCP_HTTP_PORT="$(dequote "$v")" ;;
            EMCP_HTTPS_PORT)        [ -z "$EMCP_HTTPS_PORT" ]       && EMCP_HTTPS_PORT="$(dequote "$v")" ;;
            EMCP_LOG_LEVEL)         [ -z "$EMCP_LOG_LEVEL" ]        && EMCP_LOG_LEVEL="$(dequote "$v")" ;;
            EMCP_POSTGRES_USER)     [ -z "$EMCP_POSTGRES_USER" ]    && EMCP_POSTGRES_USER="$(dequote "$v")" ;;
            EMCP_POSTGRES_DB)       [ -z "$EMCP_POSTGRES_DB" ]      && EMCP_POSTGRES_DB="$(dequote "$v")" ;;
            EMCP_SEARXNG_SECRET)    EMCP_SEARXNG_SECRET_EXISTING="$(dequote "$v")" ;;
            EMCP_PROXY_URLS)        [ -z "$EMCP_PROXY_URLS" ]       && EMCP_PROXY_URLS="$(dequote "$v")" ;;
            EMCP_PROXY_ROTATION)    [ -z "$EMCP_PROXY_ROTATION" ]   && EMCP_PROXY_ROTATION="$(dequote "$v")" ;;
            EMCP_SEARXNG_OUTGOING_PROXIES)
                if [ "$EMCP_SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
                    EMCP_SEARXNG_OUTGOING_PROXIES="$(dequote "$v")"
                    EMCP_SEARXNG_OUTGOING_PROXIES_SET=1
                fi ;;
        esac
    done < <(grep -E '^[A-Z_]+=' "$f" || true)
}

dequote() { local s="$1"; s="${s%\"}"; s="${s#\"}"; printf '%s' "$s"; }

# Mask the user:pass segment of a proxy URL for display. Mirrors
# maskProxyUrl in src/shared/net/proxy/redact.ts so the CLI and the
# runtime speak the same language about redaction.
mask_proxy_url() {
    local url="$1"
    # sed -E: replace `scheme://...@` with `scheme://***@`. Leaves
    # credential-less URLs untouched.
    printf '%s' "$url" | sed -E 's|^([A-Za-z][A-Za-z0-9+.-]*://)[^@/?#]*@|\1***@|'
}

mask_proxy_url_csv() {
    local csv="$1"
    local out=""
    local old_ifs="$IFS"
    IFS=','
    # shellcheck disable=SC2086
    set -- $csv
    IFS="$old_ifs"
    for raw in "$@"; do
        local trimmed
        trimmed="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
        [ -z "$trimmed" ] && continue
        if [ -z "$out" ]; then
            out="$(mask_proxy_url "$trimmed")"
        else
            out="${out},$(mask_proxy_url "$trimmed")"
        fi
    done
    printf '%s' "$out"
}

# Validate a single proxy URL: http:// or https:// scheme, non-empty
# host, optional user:pass. Returns 0 on success, 1 (with a log_warn)
# on failure. Prints no credentials — only the host:port portion.
validate_proxy_url() {
    local url="$1"
    case "$url" in
        http://*|https://*) : ;;
        *) log_warn "proxy URL must start with http:// or https://"; return 1 ;;
    esac
    # Strip the scheme, then strip userinfo if present to get "host[:port]/path".
    local after_scheme host_part
    after_scheme="${url#*://}"
    host_part="${after_scheme#*@}"
    # If `#*@` didn't strip anything (no @ in URL), host_part == after_scheme.
    # Pull just the host:port fragment (up to first /, ?, or #).
    host_part="${host_part%%/*}"
    host_part="${host_part%%\?*}"
    host_part="${host_part%%#*}"
    if [ -z "$host_part" ]; then
        log_warn "proxy URL has no host: $(mask_proxy_url "$url")"
        return 1
    fi
    return 0
}

# Validate every URL in a CSV. Returns 0 only when every token parses.
validate_proxy_csv() {
    local csv="$1"
    local old_ifs="$IFS"
    IFS=','
    # shellcheck disable=SC2086
    set -- $csv
    IFS="$old_ifs"
    for raw in "$@"; do
        local trimmed
        trimmed="$(printf '%s' "$raw" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')"
        [ -z "$trimmed" ] && continue
        validate_proxy_url "$trimmed" || return 1
    done
    return 0
}

# Keys the wizard owns in the .env block. Anything else present in an
# existing .env is preserved verbatim under "# --- Preserved user overrides
# ---" so `emcp config` and upgrades don't silently drop operator-added
# tunables like EMCP_MCP_MAX_BODY_BYTES or EMCP_TRUSTED_PROXY_CIDRS.
EMCP_MANAGED_ENV_KEYS=(
    NODE_ENV
    EMCP_LOG_LEVEL
    EMCP_PUBLIC_HOST
    EMCP_ALLOWED_ORIGINS
    EMCP_POSTGRES_USER
    EMCP_POSTGRES_DB
    EMCP_SEARXNG_SECRET
    EMCP_SEARXNG_OUTGOING_PROXIES
    EMCP_PUBLIC_SCHEME
    EMCP_HTTP_PORT
    EMCP_HTTPS_PORT
    EMCP_GHCR_OWNER
    EMCP_IMAGE_TAG
    EMCP_PULL_POLICY
    EMCP_DATABASE_POOL_MAX
    EMCP_RATE_LIMIT_DEFAULT_PER_MINUTE
    EMCP_SHUTDOWN_TIMEOUT_MS
    EMCP_PROXY_URLS
    EMCP_PROXY_ROTATION
    EMCP_PROXY_FAILURE_COOLDOWN_MS
    EMCP_PROXY_MAX_RETRIES_PER_REQUEST
    EMCP_PROXY_CONNECT_TIMEOUT_MS
)

# Append every KEY=VALUE line from $src whose KEY is NOT in
# EMCP_MANAGED_ENV_KEYS to $out. Comments and blank lines are dropped
# because the new managed block has its own commentary.
preserve_overrides() {
    local src="$1" out="$2"
    [ -f "$src" ] || return 0
    local pat
    pat="$(IFS='|'; printf '%s' "^(${EMCP_MANAGED_ENV_KEYS[*]})=")"
    awk -v pat="$pat" '
        /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
        /^[A-Za-z_][A-Za-z0-9_]*=/ { if ($0 !~ pat) print $0 }
    ' "$src" >> "$out"
}

write_env_file() {
    local searxng_secret="$1"
    local f="$EMCP_HOME/.env"
    local ts backup="" tmp preserved
    ts="$(date -u +%Y%m%dT%H%M%SZ)"

    # Back up the existing .env before we touch it. Atomic rename at the
    # end means any operator edit between now and the mv is irrelevant —
    # but the timestamped backup preserves hand-tuned overrides if the
    # preserve_overrides awk misses them (e.g. non-standard key names).
    if [ -f "$f" ]; then
        backup="$f.bak.$ts"
        cp -a "$f" "$backup"
        log_info "backed up existing .env → $(basename "$backup")"
    fi

    tmp="$(mktemp "$EMCP_HOME/.env.new.XXXX")"
    cat > "$tmp" <<EOF
# Managed by eMCP installer ($EMCP_INSTALLER_VERSION) — edit freely and run
# \`emcp restart\` to apply. Re-running the installer uses these values as
# defaults, so manual edits survive an upgrade. Any keys not listed here
# are preserved in the section below this one, in the order they appeared
# in the previous .env.

# --- Runtime ---
NODE_ENV=production
EMCP_LOG_LEVEL=${EMCP_LOG_LEVEL}

# --- Public identity ---
EMCP_PUBLIC_HOST=${EMCP_PUBLIC_HOST}
EMCP_ALLOWED_ORIGINS=${EMCP_ALLOWED_ORIGINS}

# --- Postgres ---
EMCP_POSTGRES_USER=${EMCP_POSTGRES_USER}
EMCP_POSTGRES_DB=${EMCP_POSTGRES_DB}

# --- SearXNG ---
EMCP_SEARXNG_SECRET=${searxng_secret}
EMCP_SEARXNG_OUTGOING_PROXIES=${EMCP_SEARXNG_OUTGOING_PROXIES}

# --- Caddy / TLS ---
EMCP_PUBLIC_SCHEME=${EMCP_PUBLIC_SCHEME}
EMCP_HTTP_PORT=${EMCP_HTTP_PORT}
EMCP_HTTPS_PORT=${EMCP_HTTPS_PORT}

# --- Image pinning ---
EMCP_GHCR_OWNER=banald
EMCP_IMAGE_TAG=${IMAGE_TAG}
EMCP_PULL_POLICY=always

# --- Limits (compose defaults are fine; override here if you need to) ---
EMCP_DATABASE_POOL_MAX=10
EMCP_RATE_LIMIT_DEFAULT_PER_MINUTE=60
EMCP_SHUTDOWN_TIMEOUT_MS=30000

# --- Outbound proxy rotation (optional) ---
# EMCP_PROXY_URLS is a comma-separated list of http(s) proxy URLs the
# mcp-server + mcp-worker processes rotate across for every external
# fetch. Empty = feature disabled. See docs/ARCHITECTURE.md "Proxy
# egress" for the full semantics.
EMCP_PROXY_URLS=${EMCP_PROXY_URLS}
EMCP_PROXY_ROTATION=${EMCP_PROXY_ROTATION:-round-robin}
EMCP_PROXY_FAILURE_COOLDOWN_MS=60000
EMCP_PROXY_MAX_RETRIES_PER_REQUEST=3
EMCP_PROXY_CONNECT_TIMEOUT_MS=10000
EOF

    # Append preserved lines from the old .env, if any.
    preserved="$(mktemp)"
    if [ -n "$backup" ]; then
        preserve_overrides "$backup" "$preserved"
    fi
    if [ -s "$preserved" ]; then
        printf '\n# --- Preserved user overrides ---\n' >> "$tmp"
        cat "$preserved" >> "$tmp"
        log_info "preserved $(wc -l < "$preserved" | tr -d ' ') user-added env line(s)"
    fi
    rm -f "$preserved"

    # chmod before rename so there's no gap where a reader could grab a
    # permissive tmp file.
    chmod 0600 "$tmp"
    mv -f "$tmp" "$f"
}

# --- Proxy wizard ----------------------------------------------------------

phase_proxy_wizard() {
    log_step "Optional: outbound proxy rotation"

    # Flag short-circuits: --no-proxy or explicit --proxy-urls="" mean
    # "don't enable proxies". An existing EMCP_PROXY_URLS value is
    # treated as the default answer in re-runs.
    if [ "$NO_PROXY_FLAG" -eq 1 ]; then
        EMCP_PROXY_URLS=""
        EMCP_PROXY_ROTATION="${EMCP_PROXY_ROTATION:-round-robin}"
        # Only clear EMCP_SEARXNG_OUTGOING_PROXIES if the operator didn't
        # explicitly supply --searxng-proxies — that flag is allowed to
        # diverge from the server-side pool.
        if [ "$EMCP_SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
            EMCP_SEARXNG_OUTGOING_PROXIES=""
        fi
        log_info "proxy rotation disabled (--no-proxy)"
        return 0
    fi

    # If EMCP_PROXY_URLS is non-empty already (from a flag or existing
    # .env), skip the yes/no prompt. The operator has already chosen.
    local skip_prompt=0
    if [ -n "$EMCP_PROXY_URLS" ]; then
        skip_prompt=1
    fi

    if [ "$skip_prompt" -eq 0 ]; then
        if [ "$NON_INTERACTIVE" -eq 1 ]; then
            # --non-interactive with no --proxy-urls and no existing
            # value → feature stays off. The operator can always re-run
            # with --proxy-urls later.
            EMCP_PROXY_URLS=""
            EMCP_PROXY_ROTATION="${EMCP_PROXY_ROTATION:-round-robin}"
            if [ "$EMCP_SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
                EMCP_SEARXNG_OUTGOING_PROXIES=""
            fi
            log_info "proxy rotation not configured (--non-interactive without --proxy-urls)"
            return 0
        fi
        if ! prompt_yesno "Route outbound HTTP through rotating proxies? Useful when SearXNG engines or upstream APIs rate-limit by IP." n; then
            EMCP_PROXY_URLS=""
            EMCP_PROXY_ROTATION="${EMCP_PROXY_ROTATION:-round-robin}"
            if [ "$EMCP_SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
                EMCP_SEARXNG_OUTGOING_PROXIES=""
            fi
            log_info "proxy rotation skipped"
            return 0
        fi
    fi

    # Collect + validate EMCP_PROXY_URLS.
    while true; do
        local current="$EMCP_PROXY_URLS"
        # Prompt explicitly so the confirm line shows a masked default.
        if [ -n "$current" ]; then
            if ! prompt_yesno "Keep existing proxy list ($(mask_proxy_url_csv "$current"))?" y; then
                current=""
            fi
        fi
        if [ -z "$current" ]; then
            if [ "$NON_INTERACTIVE" -eq 1 ]; then
                die "--non-interactive: --proxy-urls is required when the wizard would otherwise prompt"
            fi
            tty_read -r -p "${C_CYAN}?${C_RESET} Comma-separated proxy URLs (http://user:pass@host:port,...): " current
        fi
        if [ -z "$current" ]; then
            log_warn "proxy URL list cannot be empty when the feature is enabled"
            continue
        fi
        if validate_proxy_csv "$current"; then
            EMCP_PROXY_URLS="$current"
            break
        fi
    done
    log_info "proxies configured: $(mask_proxy_url_csv "$EMCP_PROXY_URLS")"

    # Rotation strategy.
    local default_rotation="${EMCP_PROXY_ROTATION:-round-robin}"
    EMCP_PROXY_ROTATION=""
    prompt EMCP_PROXY_ROTATION "Rotation strategy (round-robin | random)" "$default_rotation" validate_rotation

    # SearXNG proxies: default to the same list so the common "rotate
    # everything" case is a single prompt. Offer the operator a chance
    # to use a different list (or leave SearXNG on direct).
    if [ "$EMCP_SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
        if [ "$NON_INTERACTIVE" -eq 1 ]; then
            EMCP_SEARXNG_OUTGOING_PROXIES="$EMCP_PROXY_URLS"
        elif prompt_yesno "Use the same proxies for SearXNG's engine scrapers?" y; then
            EMCP_SEARXNG_OUTGOING_PROXIES="$EMCP_PROXY_URLS"
        else
            local searxng_input=""
            tty_read -r -p "${C_CYAN}?${C_RESET} SearXNG proxy URLs (blank = direct egress): " searxng_input
            if [ -n "$searxng_input" ] && ! validate_proxy_csv "$searxng_input"; then
                log_warn "invalid SearXNG proxy list; falling back to direct egress"
                EMCP_SEARXNG_OUTGOING_PROXIES=""
            else
                EMCP_SEARXNG_OUTGOING_PROXIES="$searxng_input"
            fi
        fi
        EMCP_SEARXNG_OUTGOING_PROXIES_SET=1
    fi
    if [ -n "$EMCP_SEARXNG_OUTGOING_PROXIES" ]; then
        log_info "SearXNG proxies: $(mask_proxy_url_csv "$EMCP_SEARXNG_OUTGOING_PROXIES")"
    else
        log_info "SearXNG engines will egress directly (no proxy)"
    fi
}

validate_rotation() {
    case "$1" in
        round-robin|random) return 0 ;;
        *) log_warn "rotation must be 'round-robin' or 'random'"; return 1 ;;
    esac
}

# --- Port utilities --------------------------------------------------------

port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn "sport = :$port" 2>/dev/null | awk 'NR>1' | grep -q . && return 0
    fi
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$port" -sTCP:LISTEN -Pn 2>/dev/null | grep -q . && return 0
    fi
    return 1
}

# True when this install's caddy container is already running and publishing
# the given port. Used to squelch the bogus "port already in use" prompt on
# `emcp config` — caddy holding 80/443 is expected state.
caddy_holds_port() {
    local port="$1"
    # Compose must exist in $EMCP_HOME to check.
    [ -f "$EMCP_HOME/compose.yaml" ] || return 1
    compose_cd ps caddy --format json 2>/dev/null \
        | grep -q '"State":"running"' || return 1
    case "$port" in
        "$EMCP_HTTP_PORT"|"$EMCP_HTTPS_PORT") return 0 ;;
        80|443) return 0 ;;
    esac
    return 1
}

# If a port is occupied, ask the user whether to bump to the alternate port.
# Returns 0 if they want the alternate port, 1 if they want to keep the
# original (they'll deal with it themselves).
resolve_port_conflict() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        log_info "listeners on :$port:"
        ss -ltnp "sport = :$port" 2>/dev/null | awk 'NR>1' >&2 || true
    fi
    if prompt_yesno "use an alternate port instead?" y; then
        return 0
    fi
    return 1
}

# --- ghcr.io login ---------------------------------------------------------

phase_ghcr_login() {
    log_step "Authenticate to ghcr.io"

    local image="${IMAGE_REPO}:${IMAGE_TAG}"

    # Cheap probe: can we already pull it? (Public image, or docker login already cached.)
    if docker manifest inspect "$image" >/dev/null 2>&1; then
        log_ok "already authenticated (or image is public); skipping login"
        return 0
    fi

    # Supplied token file / env var has priority.
    if [ -n "$GHCR_TOKEN_FILE" ]; then
        [ -r "$GHCR_TOKEN_FILE" ] || die "--ghcr-token-file: $GHCR_TOKEN_FILE is not readable"
        docker_login_with_token "$(cat "$GHCR_TOKEN_FILE")" "${REPO_OWNER,,}"
        return 0
    fi
    if [ -n "${GHCR_TOKEN:-}" ]; then
        docker_login_with_token "$GHCR_TOKEN" "${REPO_OWNER,,}"
        return 0
    fi

    # Try the gh CLI.
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
        log_info "using gh CLI to mint a read:packages token"
        gh auth refresh -s read:packages >/dev/null 2>&1 || true
        local gh_user gh_token
        gh_user="$(gh api user -q .login 2>/dev/null || true)"
        gh_token="$(gh auth token 2>/dev/null || true)"
        if [ -n "$gh_token" ] && [ -n "$gh_user" ]; then
            docker_login_with_token "$gh_token" "$gh_user"
            return 0
        fi
        log_warn "gh CLI present but token fetch failed; falling back to manual PAT"
    fi

    if [ "$NON_INTERACTIVE" -eq 1 ]; then
        if [ "$AUTO_NON_INTERACTIVE" -eq 1 ]; then
            die "no TTY — supply GHCR_TOKEN, --ghcr-token-file, or sign in with 'gh auth login' before piping from curl"
        fi
        die "--non-interactive requires GHCR_TOKEN, --ghcr-token-file, or a signed-in gh CLI"
    fi

    log_info "no gh CLI detected — manual PAT entry"
    log_info "create a token with 'read:packages' scope at:"
    log_info "  https://github.com/settings/tokens/new?scopes=read:packages"
    local pat
    prompt_secret pat "paste the token"
    [ -n "$pat" ] || die "empty token; aborting"
    docker_login_with_token "$pat" "${REPO_OWNER,,}"
}

docker_login_with_token() {
    local token="$1" user="$2"
    if printf '%s\n' "$token" | docker login ghcr.io -u "$user" --password-stdin >/dev/null; then
        log_ok "logged in to ghcr.io as $user"
    else
        die "docker login ghcr.io failed"
    fi
}

# --- Compose up ------------------------------------------------------------

phase_compose_up() {
    log_step "Pull images and start stack"

    # Capture pull output ourselves so we can scan it for Docker Hub
    # rate-limit signatures (M1). run_and_log would hide the stdout in the
    # log file only; for remediation we also need it in-memory.
    local pull_out pull_rc=0
    pull_out="$(compose_cd pull --quiet 2>&1)" || pull_rc=$?
    log_to_file "--- docker compose pull ---"
    log_to_file "$pull_out"
    if [ "$pull_rc" -ne 0 ]; then
        if grep -qiE 'toomanyrequests|rate limit|HTTP 429' <<< "$pull_out"; then
            log_error "Docker Hub rate-limited the pull. Authenticate with 'docker login' (docker.io — *not* ghcr.io) and retry; anonymous pulls are throttled."
        fi
        printf '%s\n' "$pull_out" >&2
        die "docker compose pull failed"
    fi

    run_and_log "docker compose up -d" compose_cd up -d \
        || die "docker compose up failed"

    log_info "waiting up to ${HEALTHCHECK_TIMEOUT_SECONDS}s for services to become healthy…"
    if wait_for_healthy; then
        log_ok "stack is up and healthy"
    else
        log_warn "stack did not reach healthy state within ${HEALTHCHECK_TIMEOUT_SECONDS}s"
    fi
}

# Returns 0 when every service with a healthcheck is "healthy" AND no
# service is in a failed state. Returns 1 on timeout. Emits a per-service
# status snapshot every 15 seconds so the operator sees progress.
wait_for_healthy() {
    local deadline=$((SECONDS + HEALTHCHECK_TIMEOUT_SECONDS))
    local start=$SECONDS
    local next_snapshot=$((SECONDS + 15))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if compose_all_healthy; then
            return 0
        fi
        if [ "$SECONDS" -ge "$next_snapshot" ]; then
            log_info "still waiting (elapsed $((SECONDS - start))s / ${HEALTHCHECK_TIMEOUT_SECONDS}s)"
            compose_cd ps --format 'table {{.Service}}\t{{.State}}\t{{.Health}}' >&2 2>/dev/null || true
            next_snapshot=$((SECONDS + 15))
        fi
        sleep 3
    done
    return 1
}

compose_all_healthy() {
    local json
    json="$(compose_cd ps --format json 2>/dev/null)"
    [ -n "$json" ] || return 1

    # L1: when jq is available, parse JSON properly. `jq -s` handles both
    # NDJSON (modern compose) and array-wrapped JSON (pre-2.20). Falls
    # back to the sed-regex parser when jq is absent so the installer
    # still works on minimal hosts.
    if command -v jq >/dev/null 2>&1; then
        compose_all_healthy_jq "$json"
        return $?
    fi
    compose_all_healthy_sed "$json"
}

compose_all_healthy_jq() {
    local json="$1"
    # Emit one line per service: "service<TAB>state<TAB>health<TAB>exit".
    # The `.[]` walks whichever shape jq parses into (array or NDJSON via -s).
    local rows
    rows="$(printf '%s' "$json" | jq -rs '.[] | [.Service, .State, (.Health // ""), (.ExitCode // 0)] | @tsv' 2>/dev/null || true)"
    [ -n "$rows" ] || return 1
    local svc state health exit_code
    while IFS=$'\t' read -r svc state health exit_code; do
        [ -z "$svc" ] && continue
        if [ "$state" = "exited" ]; then
            [ "${exit_code:-1}" -ne 0 ] && return 1
            continue
        fi
        [ "$state" = "running" ] || return 1
        if [ -n "$health" ] && [ "$health" != "healthy" ]; then
            return 1
        fi
    done <<< "$rows"
    return 0
}

compose_all_healthy_sed() {
    local json="$1"
    local unhealthy=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        local state health
        state="$(printf '%s' "$line" | sed -n 's/.*"State":"\([^"]*\)".*/\1/p')"
        health="$(printf '%s' "$line" | sed -n 's/.*"Health":"\([^"]*\)".*/\1/p')"
        if [ "$state" = "exited" ]; then
            local exit_code
            exit_code="$(printf '%s' "$line" | sed -n 's/.*"ExitCode":\([0-9]*\).*/\1/p')"
            if [ "${exit_code:-1}" -ne 0 ]; then
                unhealthy=1
            fi
            continue
        fi
        if [ "$state" != "running" ]; then
            unhealthy=1
            continue
        fi
        # running + empty health = no healthcheck defined, treat as ok
        if [ -n "$health" ] && [ "$health" != "healthy" ]; then
            unhealthy=1
        fi
    done <<< "$json"
    [ "$unhealthy" -eq 0 ]
}

# --- Postflight detection + remediation -----------------------------------

phase_postflight_detection() {
    if compose_all_healthy; then
        return 0
    fi

    log_step "Diagnose unhealthy stack"
    local combined
    combined="$(cd "$EMCP_HOME" && docker compose logs --no-color --tail 200 2>&1 || true)"

    if grep -qiE 'bind: address already in use' <<< "$combined"; then
        remediate_port_conflict "$combined" && retry_compose_up && return 0
    fi

    if grep -qiE 'password authentication failed' <<< "$combined"; then
        remediate_postgres_password_mismatch && retry_compose_up && return 0
    fi

    if grep -qiE 'NOAUTH|WRONGPASS|Client sent AUTH, but no password' <<< "$combined"; then
        remediate_redis_password_mismatch && retry_compose_up && return 0
    fi

    if grep -qiE 'migrate .* exited with code [1-9]' <<< "$combined" \
       || (cd "$EMCP_HOME" && docker compose ps --format json 2>/dev/null \
           | grep -q '"Service":"migrate"' \
           && cd "$EMCP_HOME" && docker compose ps migrate --format json 2>/dev/null \
           | grep -q '"ExitCode":[1-9]'); then
        log_error "migrations failed. Last 80 lines:"
        ( cd "$EMCP_HOME" && docker compose logs --no-color --tail 80 migrate ) >&2 || true
        log_error "manual recovery: see docs/OPERATIONS.md — Database migrations."
    fi

    log_error "one or more services are unhealthy after ${HEALTHCHECK_TIMEOUT_SECONDS}s"
    ( cd "$EMCP_HOME" && docker compose ps ) >&2
    die "install did not complete; see messages above"
}

remediate_port_conflict() {
    local combined="$1"
    # Find the port that collided.
    local collided_port=""
    collided_port="$(grep -oiE 'bind for 0\.0\.0\.0:[0-9]+ failed' <<< "$combined" | head -n1 | grep -oE '[0-9]+' || true)"
    [ -n "$collided_port" ] || collided_port="$(grep -oiE '0\.0\.0\.0:[0-9]+: bind: address already in use' <<< "$combined" | head -n1 | grep -oE '[0-9]+' || true)"

    log_error "port ${collided_port:-<unknown>} is already in use on the host"
    if command -v ss >/dev/null 2>&1 && [ -n "$collided_port" ]; then
        log_error "holder:"
        ss -ltnp "sport = :$collided_port" 2>/dev/null | awk 'NR>1' >&2 || true
    fi

    echo "  (a) pick a different port and retry" >&2
    echo "  (b) stop the holder yourself, then retry" >&2
    echo "  (c) abort" >&2
    local choice
    tty_read -r -p "choice [a/b/c]: " choice
    case "${choice,,}" in
        a)
            local new_port
            tty_read -r -p "new port (e.g. 8443): " new_port
            validate_port "$new_port" || return 1
            if [ "${collided_port:-0}" = "${EMCP_HTTPS_PORT:-0}" ]; then
                EMCP_HTTPS_PORT="$new_port"
                sed -i "s/^EMCP_HTTPS_PORT=.*/EMCP_HTTPS_PORT=${new_port}/" "$EMCP_HOME/.env"
            else
                EMCP_HTTP_PORT="$new_port"
                sed -i "s/^EMCP_HTTP_PORT=.*/EMCP_HTTP_PORT=${new_port}/" "$EMCP_HOME/.env"
            fi
            log_info "updated .env; will retry compose up"
            return 0
            ;;
        b)
            tty_read -r -p "press Enter when the port is free " _
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

remediate_postgres_password_mismatch() {
    log_error "Postgres reports 'password authentication failed'."
    log_error "This usually means the 'pgdata' volume was initialized with a"
    log_error "different password than secrets/postgres_password.txt currently holds."
    echo "  (a) wipe the pgdata volume and start fresh  (DESTROYS ALL DATA)" >&2
    echo "  (b) paste the ORIGINAL postgres password — I will restore it"    >&2
    echo "  (c) abort and let me fix this manually"                          >&2
    local choice
    tty_read -r -p "choice [a/b/c]: " choice
    case "${choice,,}" in
        a)
            if ! prompt_yesno "are you SURE you want to destroy all eMCP data?" n; then
                return 1
            fi
            if ! prompt_yesno "once more — this is destructive. Continue?" n; then
                return 1
            fi
            ( cd "$EMCP_HOME" && docker compose down -v ) || return 1
            log_info "pgdata volume destroyed; retrying up…"
            return 0
            ;;
        b)
            local pw
            prompt_secret pw "paste the original postgres password"
            [ -n "$pw" ] || return 1
            printf '%s\n' "$pw" > "$EMCP_HOME/secrets/postgres_password.txt"
            chmod 0644 "$EMCP_HOME/secrets/postgres_password.txt"
            log_info "postgres_password.txt restored; retrying up…"
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

# Redis in our compose stack runs without persistence (no RDB, no AOF —
# see compose.yaml comments). So a NOAUTH/WRONGPASS mismatch is almost
# always because secrets/redis_password.txt was rotated without
# restarting redis. The fix is simply "regenerate + bounce the three
# consumers". No data-loss prompt because there's no data to lose.
remediate_redis_password_mismatch() {
    log_error "Redis auth failed (NOAUTH/WRONGPASS detected in mcp-server logs)."
    log_error "secrets/redis_password.txt almost certainly diverged from the"
    log_error "running redis container. Redis has no persistent state here, so"
    log_error "the fix is: regenerate the secret and bounce redis + the two app"
    log_error "processes. No data is lost (rate-limit cache is ephemeral by design)."
    if ! prompt_yesno "regenerate redis password and restart redis + mcp-server + mcp-worker?" y; then
        return 1
    fi
    rm -f "$EMCP_HOME/secrets/redis_password.txt"
    generate_secret_if_missing "$EMCP_HOME/secrets/redis_password.txt" 24 "redis password"
    run_and_log "docker compose restart redis mcp-server mcp-worker" \
        compose_cd restart redis mcp-server mcp-worker || return 1
    log_info "redis password rotated; retrying healthcheck…"
    return 0
}

retry_compose_up() {
    log_info "retrying docker compose up -d"
    run_and_log "docker compose up -d (retry)" compose_cd up -d || return 1
    wait_for_healthy || return 1
    return 0
}

# --- Smoke test -----------------------------------------------------------

# POST /mcp with a bogus Authorization bearer via loopback — using
# curl --resolve so the Host header matches EMCP_PUBLIC_HOST. A healthy
# stack returns HTTP 401 (AuthRequiredError) from the auth middleware:
# that's the "auth is actually running" signal. Anything else is a
# misconfiguration or a warming state. Always warning-only — never blocks
# the install on a "new deploy, Let's Encrypt not ready" scenario.
phase_smoke_test() {
    log_step "Smoke test: verify auth middleware on /mcp"

    if ! command -v curl >/dev/null 2>&1; then
        log_warn "curl missing; skipping smoke test"
        return 0
    fi

    local scheme="${EMCP_PUBLIC_SCHEME:-https}"
    local host="${EMCP_PUBLIC_HOST:-localhost}"
    local port
    if [ "$scheme" = "https" ]; then
        port="${EMCP_HTTPS_PORT:-443}"
    else
        port="${EMCP_HTTP_PORT:-80}"
    fi
    local url="${scheme}://${host}:${port}/mcp"

    local -a curl_args=(
        --max-time 5
        --silent
        --output /dev/null
        --write-out '%{http_code}'
        --resolve "${host}:${port}:127.0.0.1"
        -H 'Content-Type: application/json'
        -H 'Authorization: Bearer smoketest-not-a-real-key'
        -X POST
        -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"emcp-installer-smoke","version":"1"}}}'
    )
    [ "$scheme" = "https" ] && curl_args+=(-k)

    local rc=0 code
    code="$(curl "${curl_args[@]}" "$url" 2>/dev/null)" || rc=$?

    case "${rc}:${code}" in
        0:401)
            log_ok "/mcp returned 401 for a bogus key — auth middleware is active" ;;
        0:403)
            log_warn "/mcp returned 403 — check EMCP_ALLOWED_ORIGINS and EMCP_PUBLIC_HOST match the client's expected values" ;;
        0:429)
            log_warn "/mcp returned 429 — pre-auth rate limit fired on a smoke test; inspect EMCP_PRE_AUTH_RATE_LIMIT_PER_MINUTE" ;;
        0:2??)
            log_warn "/mcp returned ${code} — a bogus key should not succeed. Auth layer may not be active" ;;
        0:5??)
            log_warn "/mcp returned ${code} — server error before the auth check. See: emcp logs mcp-server" ;;
        0:*)
            log_warn "/mcp returned unexpected HTTP ${code:-<empty>}" ;;
        6:*|7:*|28:*)
            log_warn "could not reach $url (curl exit $rc); the stack may still be warming up" ;;
        35:*|60:*|77:*)
            log_warn "TLS handshake failed at $url (curl exit $rc); Let's Encrypt may not be ready yet — retry 'emcp health' in 60s" ;;
        *)
            log_warn "smoke test inconclusive: curl exit $rc, HTTP ${code:-<empty>}" ;;
    esac
    return 0
}

# --- Install emcp CLI ------------------------------------------------------

phase_install_emcp() {
    log_step "Install the 'emcp' command"

    mkdir -p "$(dirname "$EMCP_CONFIG_PATH")"
    cat > "$EMCP_CONFIG_PATH" <<EOF
# Managed by install.sh ($EMCP_INSTALLER_VERSION).
EMCP_HOME=${EMCP_HOME}
EOF
    chmod 0644 "$EMCP_CONFIG_PATH"

    local emcp_src
    if [ -n "$FROM_LOCAL" ] && [ -f "$FROM_LOCAL/scripts/emcp" ]; then
        emcp_src="$FROM_LOCAL/scripts/emcp"
    elif [ -f "$EMCP_HOME/scripts/emcp" ]; then
        emcp_src="$EMCP_HOME/scripts/emcp"
    else
        # Fallback: fetch the tagged copy from GitHub raw.
        local url="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${TAG}/scripts/emcp"
        emcp_src="$(mktemp)"
        if ! curl -fsSL "$url" -o "$emcp_src"; then
            die "cannot locate scripts/emcp (not in source tree; raw download from $url failed)"
        fi
    fi

    install -D -m 0755 "$emcp_src" "$EMCP_BIN_PATH"

    # Also save this installer inside $EMCP_HOME so `emcp config` and
    # `emcp uninstall` can re-run it later. `curl | sudo bash` streams the
    # script from stdin and `$0` is the shell itself (not a file on disk),
    # so refetch from the release in that case.
    save_installer_copy

    log_ok "emcp installed at $EMCP_BIN_PATH (config at $EMCP_CONFIG_PATH)"
}

save_installer_copy() {
    local dest="$EMCP_HOME/$INSTALLER_SAVE_PATH_REL"
    mkdir -p "$(dirname "$dest")"
    if [ -f "$0" ] && head -n1 "$0" 2>/dev/null | grep -q '^#!'; then
        cp -f "$0" "$dest"
        chmod 0755 "$dest"
        return 0
    fi
    # M7: the raw-source fallback was removed because it ships the
    # UNSTAMPED copy (`EMCP_INSTALLER_VERSION="v0.0.0-dev"`), which breaks
    # `emcp version` and `emcp config` downstream. Try only the stamped
    # release asset; warn loudly if it's unreachable.
    local url="https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/install.sh"
    if curl -fsSL "$url" -o "$dest" 2>/dev/null; then
        chmod 0755 "$dest"
        return 0
    fi
    log_warn "could not save installer copy at $dest"
    log_warn "'emcp config' / 'emcp uninstall' will need install.sh re-downloaded from $url"
}

# --- First API key ---------------------------------------------------------

phase_first_key() {
    if [ "$SKIP_FIRST_KEY" -eq 1 ]; then
        return 0
    fi
    # M6: NON_INTERACTIVE can't answer the "create a key?" prompt, and the
    # default-y path would auto-create a key whose raw value scrolls by
    # invisibly in an unattended run. Skip cleanly and tell the operator
    # how to create one later.
    if [ "$NON_INTERACTIVE" -eq 1 ]; then
        log_info "non-interactive: skipping first-key creation. Create one later with: emcp key create --name \"<name>\""
        return 0
    fi
    log_step "Create the first API key"
    if ! prompt_yesno "create an API key now?" y; then
        log_info "skipped; create one later with: emcp key create --name \"<name>\""
        return 0
    fi
    local host name
    host="$(hostname -s 2>/dev/null || echo host)"
    name="${USER:-operator}@${host}"
    prompt name "name for this key" "$name" validate_nonempty

    # -T disables TTY allocation so we can capture stdout cleanly. We still
    # want stderr mixed in so the "SAVE THIS KEY NOW" warning from keys.ts
    # shows up inside our box, not separately scrolling.
    local key_out
    if ! key_out="$(compose_cd run --rm -T mcp-server \
        node dist/cli/keys.js create --name "$name" 2>&1)"; then
        log_error "key creation failed; retry with: emcp key create --name \"$name\""
        printf '%s\n' "$key_out" >&2
        return 0
    fi

    printf '\n%s%s%s\n' "$C_BOLD" "┌──────────────────────────────────────────────────────────────┐" "$C_RESET" >&2
    printf '%s%s%s\n'   "$C_BOLD" "│  SAVE THIS KEY NOW — IT WILL NEVER BE SHOWN AGAIN            │" "$C_RESET" >&2
    printf '%s%s%s\n'   "$C_BOLD" "└──────────────────────────────────────────────────────────────┘" "$C_RESET" >&2
    printf '%s\n' "$key_out" >&2
    printf '%s\n\n' "────────────────────────────────────────────────────────────────" >&2
    # Don't mirror the raw key into the install log.
    log_to_file "(first-key created; raw key not logged)"

    local raw_key
    raw_key="$(printf '%s\n' "$key_out" | grep -oE '^mcp_live_[A-Za-z0-9_-]{43}$' | head -n1 || true)"
    if [ -n "$raw_key" ] \
       && prompt_yesno "Also save the raw key to $EMCP_HOME/first-key.txt (0600)?" n; then
        ( umask 077 && printf '%s\n' "$raw_key" > "$EMCP_HOME/first-key.txt" )
        log_info "saved → $EMCP_HOME/first-key.txt (delete after you've stored it elsewhere)"
    fi
}

# --- Summary ---------------------------------------------------------------

phase_summary() {
    log_step "Done"
    local endpoint
    if [ "$EMCP_PUBLIC_SCHEME" = "https" ] && [ "${EMCP_HTTPS_PORT:-443}" = "443" ]; then
        endpoint="https://${EMCP_PUBLIC_HOST}/mcp"
    elif [ "$EMCP_PUBLIC_SCHEME" = "https" ]; then
        endpoint="https://${EMCP_PUBLIC_HOST}:${EMCP_HTTPS_PORT}/mcp"
    elif [ "${EMCP_HTTP_PORT:-80}" = "80" ]; then
        endpoint="http://${EMCP_PUBLIC_HOST}/mcp"
    else
        endpoint="http://${EMCP_PUBLIC_HOST}:${EMCP_HTTP_PORT}/mcp"
    fi

    cat <<EOF >&2

eMCP is running.

  MCP endpoint:   ${C_BOLD}${endpoint}${C_RESET}
  Install dir:    ${EMCP_HOME}
  Installer tag:  ${EMCP_INSTALLER_VERSION}

Day-2 commands (run from anywhere):
  emcp status          show container status
  emcp logs            tail logs for all services
  emcp logs mcp-server tail logs for one service
  emcp key list        list API keys
  emcp key create --name "..."
  emcp key delete <id-or-prefix>
  emcp migrate         apply pending migrations
  emcp update          pull the latest image tag and restart
  emcp restart         restart the stack in place
  emcp down            stop the stack (preserves data)
  emcp uninstall       stop and remove everything (destroys data)

Claude Code / IDE MCP client config (paste into ~/.config/claude-code/settings.json
or your client's equivalent):

  "mcpServers": {
    "emcp": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer <paste-key-from-emcp-key-create>" }
    }
  }

Full docs: https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${TAG}/docs/OPERATIONS.md

EOF
}

# --- Uninstall -------------------------------------------------------------

phase_uninstall() {
    log_step "Uninstall eMCP"

    # Resolve symlinks + strip trailing slash so /opt/emcp/../ or a symlink
    # to / can't slip past the denylist. `readlink -f` follows everything;
    # if it fails we fall back to the raw path (safer to refuse than to
    # guess).
    local resolved
    resolved="$(readlink -f "$EMCP_HOME" 2>/dev/null || printf '%s' "$EMCP_HOME")"
    resolved="${resolved%/}"

    case "$resolved" in
        ""|"/"|"/root"|"/home"|"/etc"|"/usr"|"/var"|"/opt" \
            |"/bin"|"/sbin"|"/lib"|"/lib64" \
            |"/boot"|"/sys"|"/proc"|"/dev"|"/tmp")
            die "refusing to uninstall — EMCP_HOME=${resolved:-<empty>} is a system path. Pass an explicit --install-dir pointing at the eMCP install directory." ;;
    esac
    # Require at least two path segments (e.g. /opt/emcp is fine, /opt is
    # not). `case` patterns anchor on '/' for the first segment; `/*/*` only
    # matches when there's a second '/' with at least one char after it.
    case "$resolved" in
        /*/*) : ;;
        *) die "refusing to uninstall — EMCP_HOME=${resolved} has fewer than two path segments." ;;
    esac

    if [ "$FORCE" -eq 1 ]; then
        log_warn "--force set; skipping confirmation for destructive uninstall of $resolved"
    else
        if ! prompt_yesno "this will stop the stack, delete $resolved, remove $EMCP_BIN_PATH, and wipe all data volumes. Continue?" n; then
            die "aborted"
        fi
        if ! prompt_yesno "are you SURE? This destroys the database." n; then
            die "aborted"
        fi
    fi
    if [ -f "$resolved/compose.yaml" ]; then
        ( cd "$resolved" && docker compose down -v ) || log_warn "compose down -v returned non-zero"
    fi
    rm -rf "$resolved"
    # We just deleted the install log's parent directory; further log_*
    # calls would try to write into nonexistent paths. Clear the pointer
    # so the remaining log_ok lands only on the terminal.
    INSTALL_LOG_PATH=""
    rm -f "$EMCP_BIN_PATH" "$EMCP_CONFIG_PATH"
    rmdir "$(dirname "$EMCP_CONFIG_PATH")" 2>/dev/null || true
    log_ok "eMCP uninstalled."
}

# --- Reconfigure -----------------------------------------------------------

phase_reconfigure() {
    [ -f "$EMCP_HOME/compose.yaml" ] || die "no existing install at $EMCP_HOME (run install.sh first)"
    log_step "Reconfigure $EMCP_HOME/.env"
    phase_env_wizard
    phase_proxy_wizard
    log_info "restarting stack to pick up new .env"
    run_and_log "docker compose up -d (reconfigure)" compose_cd up -d \
        || die "docker compose up failed"
    if wait_for_healthy; then
        log_ok "stack healthy"
    else
        phase_postflight_detection
    fi
    phase_smoke_test
}

# --- Main ------------------------------------------------------------------

installer_cleanup() {
    # Always return 0 — EXIT traps inherit their exit status from the last
    # command, and an empty-array iteration's `[ -n "" ]` returns 1 which
    # would then clobber the script's real exit code (including 0 for
    # --help).
    local d
    for d in "${INSTALLER_TMP_ROOTS[@]:-}"; do
        if [ -n "$d" ] && [ -d "$d" ]; then
            rm -rf "$d"
        fi
    done
    return 0
}

main() {
    # Sweep any mktemp -d dirs we tracked when the process exits for any
    # reason (normal, die, SIGINT). Function-local RETURN traps on
    # individual phases cover the normal path; this backstop handles
    # interrupts.
    trap installer_cleanup EXIT

    # Pre-scan argv for --install-dir so the install log opens before
    # parse_args — so parse-arg errors also land in the log, and so a
    # malformed flag still produces a debuggable artifact on disk. Skip
    # log creation for pure help invocations so --help never touches the
    # filesystem.
    local i early_dir="" j is_help=0
    for ((i=1; i<=$#; i++)); do
        case "${!i}" in
            -h|--help) is_help=1 ;;
            --install-dir)
                j=$((i+1))
                early_dir="${!j:-}"
                ;;
        esac
    done
    EMCP_HOME="${early_dir:-$DEFAULT_INSTALL_DIR}"
    [ "$is_help" -eq 0 ] && init_install_log

    parse_args "$@"

    # If there's no way to reach a terminal (stdin is closed AND /dev/tty
    # can't be opened — e.g. setsid, some systemd service contexts),
    # silently accepting defaults would be worse than failing loudly. Flip
    # to non-interactive and remember the user didn't ask for it so error
    # messages can say "no TTY" instead of "--non-interactive".
    if [ "$NON_INTERACTIVE" -eq 0 ] && [ ! -t 0 ] \
       && ! (exec 0</dev/tty) 2>/dev/null; then
        NON_INTERACTIVE=1
        AUTO_NON_INTERACTIVE=1
        log_warn "no TTY detected; running non-interactively. Pass flags or supply GHCR_TOKEN=<pat>."
    fi

    if [ "$UNINSTALL" -eq 1 ]; then
        phase_uninstall
        return 0
    fi

    if [ "$RECONFIGURE" -eq 1 ]; then
        phase_preflight
        phase_reconfigure
        return 0
    fi

    phase_preflight
    phase_fetch_source
    phase_generate_secrets
    phase_env_wizard
    phase_proxy_wizard
    phase_ghcr_login
    phase_compose_up
    phase_postflight_detection
    phase_smoke_test
    phase_install_emcp
    phase_first_key
    phase_summary
}

main "$@"
