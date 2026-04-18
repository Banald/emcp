#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Echo one-shot installer
#
# Downloads the matched-tag source tarball, generates Docker secrets, walks
# you through the .env interactively, logs in to ghcr.io, brings the compose
# stack up, and installs the permanent `emcp` CLI at /usr/local/bin/emcp.
#
# Usage:
#     curl -fsSL https://github.com/Banald/echo/releases/latest/download/install.sh | sudo bash
#     # or, to inspect first:
#     curl -fsSL https://github.com/Banald/echo/releases/latest/download/install.sh -o install.sh
#     less install.sh
#     sudo bash install.sh
#
# Flags (all optional — the interactive wizard fills the gaps):
#     --install-dir <path>     default: /opt/echo
#     --tag <ref>              override the release tag (default: stamped
#                              installer version; 'main' in dev builds)
#     --public-host <host>
#     --public-scheme <https|http>
#     --allowed-origins <csv>
#     --http-port <n>
#     --https-port <n>
#     --log-level <level>
#     --postgres-user <name>
#     --postgres-db <name>
#     --image-tag <tag>        image tag to pin (default: derived from --tag)
#     --ghcr-token-file <path> PAT with read:packages (env: GHCR_TOKEN)
#     --skip-first-key
#     --non-interactive        fail fast if any answer would need a prompt
#     --reconfigure            skip source fetch / secret gen; re-run the
#                              env wizard against an existing install, then
#                              re-up the stack. Used by `emcp config`.
#     --from-local <path>      skip source fetch; use the given local repo
#                              checkout as the source tree. For dev.
#     --uninstall              see also `emcp uninstall`.
#     --force                  skip confirmation prompts (destructive ops
#                              still re-prompt for safety).
#     --proxy-urls <csv>       rotating-proxy pool (http/https URLs, CSV).
#                              Empty CSV or --no-proxy disables routing.
#     --proxy-rotation <mode>  round-robin (default) | random
#     --searxng-proxies <csv>  proxies SearXNG engines use. Empty = direct.
#                              Defaults to the same list as --proxy-urls.
#     --no-proxy               explicitly opt out of the proxy wizard
#                              (useful in --non-interactive runs).
#     -h, --help
# ---------------------------------------------------------------------------

set -euo pipefail

# Version is stamped by .github/workflows/release.yml at tag time. The sed
# match line MUST stay exact — don't reflow.
ECHO_INSTALLER_VERSION="v0.0.0-dev"

REPO_OWNER="Banald"
REPO_NAME="echo"
# ghcr.io path is always lowercase (see release.yml "Compute lowercased
# image name" step).
IMAGE_REPO="ghcr.io/banald/echo"

DEFAULT_INSTALL_DIR="/opt/echo"
EMCP_BIN_PATH="/usr/local/bin/emcp"
EMCP_CONFIG_PATH="/etc/echo/config"
INSTALLER_SAVE_PATH_REL="bin/install.sh"  # copied into $ECHO_HOME for `emcp config`
HEALTHCHECK_TIMEOUT_SECONDS=180
MIN_FREE_GB=2

# --- Parsed flags / global state -------------------------------------------

INSTALL_DIR=""
TAG=""
PUBLIC_HOST=""
PUBLIC_SCHEME=""
ALLOWED_ORIGINS=""
HTTP_PORT=""
HTTPS_PORT=""
LOG_LEVEL=""
POSTGRES_USER=""
POSTGRES_DB=""
IMAGE_TAG=""
GHCR_TOKEN_FILE=""
SKIP_FIRST_KEY=0
NON_INTERACTIVE=0
RECONFIGURE=0
FROM_LOCAL=""
UNINSTALL=0
FORCE=0
# Proxy wizard inputs. Empty means "not yet answered"; after the wizard
# runs, PROXY_URLS/SEARXNG_OUTGOING_PROXIES hold the final CSV (possibly
# empty), PROXY_ROTATION holds the strategy. NO_PROXY_FLAG=1 short-
# circuits the prompt in --non-interactive mode.
PROXY_URLS=""
PROXY_ROTATION=""
SEARXNG_OUTGOING_PROXIES=""
SEARXNG_OUTGOING_PROXIES_SET=0  # 1 when the flag or existing env set it
NO_PROXY_FLAG=0

# Filled during the run
ECHO_HOME=""
IS_UPGRADE=0
SEARXNG_SECRET_EXISTING=""

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

log_info()  { printf '%s[info]%s  %s\n'  "$C_BLUE"   "$C_RESET" "$*" >&2; }
log_warn()  { printf '%s[warn]%s  %s\n'  "$C_YELLOW" "$C_RESET" "$*" >&2; }
log_error() { printf '%s[error]%s %s\n'  "$C_RED"    "$C_RESET" "$*" >&2; }
log_ok()    { printf '%s[ok]%s    %s\n'  "$C_GREEN"  "$C_RESET" "$*" >&2; }
log_step()  { printf '\n%s==>%s %s%s%s\n' "$C_CYAN"  "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; }

die() { log_error "$*"; exit 1; }

# --- Arg parsing -----------------------------------------------------------

usage() {
    # Prints the header comment block (lines 3..end-of-block). The range
    # grew when the proxy-wizard flags were added; the end line is the
    # "# -----..." divider that closes the block at top of file.
    sed -n '3,47p' "$0"
    exit "${1:-0}"
}

parse_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --install-dir)      INSTALL_DIR="$2"; shift 2 ;;
            --tag)              TAG="$2"; shift 2 ;;
            --public-host)      PUBLIC_HOST="$2"; shift 2 ;;
            --public-scheme)    PUBLIC_SCHEME="$2"; shift 2 ;;
            --allowed-origins)  ALLOWED_ORIGINS="$2"; shift 2 ;;
            --http-port)        HTTP_PORT="$2"; shift 2 ;;
            --https-port)       HTTPS_PORT="$2"; shift 2 ;;
            --log-level)        LOG_LEVEL="$2"; shift 2 ;;
            --postgres-user)    POSTGRES_USER="$2"; shift 2 ;;
            --postgres-db)      POSTGRES_DB="$2"; shift 2 ;;
            --image-tag)        IMAGE_TAG="$2"; shift 2 ;;
            --ghcr-token-file)  GHCR_TOKEN_FILE="$2"; shift 2 ;;
            --skip-first-key)   SKIP_FIRST_KEY=1; shift ;;
            --non-interactive)  NON_INTERACTIVE=1; shift ;;
            --reconfigure)      RECONFIGURE=1; shift ;;
            --from-local)       FROM_LOCAL="$2"; shift 2 ;;
            --uninstall)        UNINSTALL=1; shift ;;
            --force)            FORCE=1; shift ;;
            --proxy-urls)       PROXY_URLS="$2"; shift 2 ;;
            --proxy-rotation)   PROXY_ROTATION="$2"; shift 2 ;;
            --searxng-proxies)
                SEARXNG_OUTGOING_PROXIES="$2"
                SEARXNG_OUTGOING_PROXIES_SET=1
                shift 2 ;;
            --no-proxy)         NO_PROXY_FLAG=1; shift ;;
            -h|--help)          usage 0 ;;
            *) die "unknown flag: $1 (try --help)" ;;
        esac
    done

    INSTALL_DIR="${INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
    ECHO_HOME="$INSTALL_DIR"

    if [ -z "$TAG" ]; then
        TAG="$ECHO_INSTALLER_VERSION"
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
            read -r -p "${C_CYAN}?${C_RESET} ${__question} [${__default}]: " __answer
        else
            read -r -p "${C_CYAN}?${C_RESET} ${__question}: " __answer
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
            read -r -p "${C_CYAN}?${C_RESET} ${__question} [Y/n]: " __answer
            __answer="${__answer:-y}"
        else
            read -r -p "${C_CYAN}?${C_RESET} ${__question} [y/N]: " __answer
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
        die "--non-interactive: $__out_var is a secret and must be supplied via --ghcr-token-file or GHCR_TOKEN."
    fi
    read -r -s -p "${C_CYAN}?${C_RESET} ${__question}: " __answer
    printf '\n' >&2
    printf -v "$__out_var" '%s' "$__answer"
}

validate_host()   { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || { log_warn "not a valid hostname"; return 1; }; }
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

    if ! docker info >/dev/null 2>&1; then
        log_error "cannot reach the Docker daemon."
        log_error "start it with: systemctl enable --now docker"
        exit 1
    fi

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

    mkdir -p "$ECHO_HOME"

    log_ok "preflight passed"
}

suggest_docker_install() {
    local id=""
    [ -r /etc/os-release ] && id="$(. /etc/os-release 2>/dev/null; echo "${ID:-}")"
    case "$id" in
        fedora|rhel|centos|rocky|almalinux)
            log_error "install with: dnf install -y docker docker-compose-plugin" ;;
        debian|ubuntu|linuxmint|pop)
            log_error "install with: apt-get install -y docker.io docker-compose-plugin" ;;
        arch|manjaro|endeavouros)
            log_error "install with: pacman -S --noconfirm docker docker-compose" ;;
        alpine)
            log_error "install with: apk add docker docker-cli-compose" ;;
        *)
            log_error "install Docker per: https://docs.docker.com/engine/install/" ;;
    esac
}

# --- Source fetch ----------------------------------------------------------

phase_fetch_source() {
    log_step "Fetch source ($TAG)"

    if [ -f "$ECHO_HOME/compose.yaml" ]; then
        IS_UPGRADE=1
        log_info "existing install detected at $ECHO_HOME"
        if ! prompt_yesno "upgrade in place (preserve secrets and .env)?" y; then
            die "aborted by user"
        fi
    fi

    if [ -n "$FROM_LOCAL" ]; then
        [ -f "$FROM_LOCAL/compose.yaml" ] || die "--from-local: $FROM_LOCAL/compose.yaml not found"
        log_info "copying from local checkout $FROM_LOCAL → $ECHO_HOME"
        copy_source_tree "$FROM_LOCAL" "$ECHO_HOME"
        return 0
    fi

    local url="https://github.com/${REPO_OWNER}/${REPO_NAME}/archive/refs/tags/${TAG}.tar.gz"
    local tmp
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' RETURN

    log_info "downloading $url"
    if ! curl -fsSL "$url" -o "$tmp/src.tar.gz"; then
        die "failed to download source tarball. Check that tag $TAG exists: https://github.com/${REPO_OWNER}/${REPO_NAME}/releases"
    fi

    tar -xzf "$tmp/src.tar.gz" -C "$tmp"
    local extracted
    extracted="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -n1)"
    [ -n "$extracted" ] || die "source tarball has unexpected layout"

    copy_source_tree "$extracted" "$ECHO_HOME"
    log_ok "source extracted to $ECHO_HOME"
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
    mkdir -p "$ECHO_HOME/secrets"

    generate_secret_if_missing "$ECHO_HOME/secrets/postgres_password.txt"   24 "postgres password"
    generate_secret_if_missing "$ECHO_HOME/secrets/redis_password.txt"      24 "redis password"

    if [ -s "$ECHO_HOME/secrets/api_key_hmac_secret.txt" ]; then
        log_info "api_key_hmac_secret.txt exists — preserving (rotating it invalidates every API key)"
    elif [ "$IS_UPGRADE" -eq 1 ]; then
        log_warn "api_key_hmac_secret.txt is missing on an upgrade. Generating a fresh one WILL invalidate every previously issued API key."
        if ! prompt_yesno "generate a new HMAC pepper and accept that all old keys will stop working?" n; then
            die "aborted; restore secrets/api_key_hmac_secret.txt from backup and re-run"
        fi
        generate_secret_if_missing "$ECHO_HOME/secrets/api_key_hmac_secret.txt" 32 "API key HMAC pepper"
    else
        generate_secret_if_missing "$ECHO_HOME/secrets/api_key_hmac_secret.txt" 32 "API key HMAC pepper"
    fi

    chmod 0644 "$ECHO_HOME/secrets"/*.txt
    log_ok "secrets ready at $ECHO_HOME/secrets/"
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

    prompt PUBLIC_HOST "Public hostname — what clients will use to reach Echo (e.g. echo.example.com, or 'localhost' for local use)" "${PUBLIC_HOST:-localhost}" validate_host

    prompt PUBLIC_SCHEME "Use HTTPS (recommended) or HTTP? HTTP is plaintext; use only on fully trusted networks" "${PUBLIC_SCHEME:-https}" validate_scheme

    if [ -z "$ALLOWED_ORIGINS" ]; then
        ALLOWED_ORIGINS="${PUBLIC_SCHEME}://${PUBLIC_HOST}"
        if [ "$PUBLIC_HOST" = "localhost" ]; then
            ALLOWED_ORIGINS="http://localhost,https://localhost"
        fi
    fi
    prompt ALLOWED_ORIGINS "Allowed Origin header values (comma-separated, include scheme)" "$ALLOWED_ORIGINS" validate_nonempty

    if [ -z "$HTTP_PORT" ]; then
        HTTP_PORT=80
        if port_in_use 80; then
            log_warn "port 80 is already in use on this host"
            resolve_port_conflict 80 && HTTP_PORT=8080
        fi
    fi
    prompt HTTP_PORT "HTTP port on the host" "$HTTP_PORT" validate_port

    if [ -z "$HTTPS_PORT" ]; then
        HTTPS_PORT=443
        if [ "$PUBLIC_SCHEME" = "https" ] && port_in_use 443; then
            log_warn "port 443 is already in use on this host"
            resolve_port_conflict 443 && HTTPS_PORT=8443
        fi
    fi
    prompt HTTPS_PORT "HTTPS port on the host" "$HTTPS_PORT" validate_port

    prompt LOG_LEVEL "Log level — leave 'info' unless debugging" "${LOG_LEVEL:-info}" validate_loglevel
    prompt POSTGRES_USER "Postgres user for the mcp database" "${POSTGRES_USER:-mcp}" validate_nonempty
    prompt POSTGRES_DB   "Postgres database name"              "${POSTGRES_DB:-mcp}"   validate_nonempty

    local searxng_secret="$SEARXNG_SECRET_EXISTING"
    [ -n "$searxng_secret" ] || searxng_secret="$(openssl rand -hex 32)"

    write_env_file "$searxng_secret"
    chmod 0600 "$ECHO_HOME/.env"
    log_ok ".env written to $ECHO_HOME/.env (0600)"
}

load_existing_env_defaults() {
    local f="$ECHO_HOME/.env"
    [ -f "$f" ] || return 0
    # Extract known keys without sourcing (the file may contain arbitrary quoting).
    local k v
    while IFS='=' read -r k v; do
        case "$k" in
            PUBLIC_HOST)       [ -z "$PUBLIC_HOST" ]      && PUBLIC_HOST="$(dequote "$v")" ;;
            PUBLIC_SCHEME)     [ -z "$PUBLIC_SCHEME" ]    && PUBLIC_SCHEME="$(dequote "$v")" ;;
            ALLOWED_ORIGINS)   [ -z "$ALLOWED_ORIGINS" ]  && ALLOWED_ORIGINS="$(dequote "$v")" ;;
            HTTP_PORT)         [ -z "$HTTP_PORT" ]        && HTTP_PORT="$(dequote "$v")" ;;
            HTTPS_PORT)        [ -z "$HTTPS_PORT" ]       && HTTPS_PORT="$(dequote "$v")" ;;
            LOG_LEVEL)         [ -z "$LOG_LEVEL" ]        && LOG_LEVEL="$(dequote "$v")" ;;
            POSTGRES_USER)     [ -z "$POSTGRES_USER" ]    && POSTGRES_USER="$(dequote "$v")" ;;
            POSTGRES_DB)       [ -z "$POSTGRES_DB" ]      && POSTGRES_DB="$(dequote "$v")" ;;
            SEARXNG_SECRET)    SEARXNG_SECRET_EXISTING="$(dequote "$v")" ;;
            PROXY_URLS)        [ -z "$PROXY_URLS" ]       && PROXY_URLS="$(dequote "$v")" ;;
            PROXY_ROTATION)    [ -z "$PROXY_ROTATION" ]   && PROXY_ROTATION="$(dequote "$v")" ;;
            SEARXNG_OUTGOING_PROXIES)
                if [ "$SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
                    SEARXNG_OUTGOING_PROXIES="$(dequote "$v")"
                    SEARXNG_OUTGOING_PROXIES_SET=1
                fi ;;
        esac
    done < <(grep -E '^[A-Z_]+=' "$f" || true)
}

dequote() { local s="$1"; s="${s%\"}"; s="${s#\"}"; printf '%s' "$s"; }

# Mask the user:pass segment of a proxy URL for echo-back. Mirrors
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
# on failure. Echoes no credentials — only the host:port portion.
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

write_env_file() {
    local searxng_secret="$1"
    local f="$ECHO_HOME/.env"
    cat > "$f" <<EOF
# Managed by Echo installer ($ECHO_INSTALLER_VERSION) — edit freely and run
# \`emcp restart\` to apply. Re-running the installer uses these values as
# defaults, so manual edits survive an upgrade.

# --- Runtime ---
NODE_ENV=production
LOG_LEVEL=${LOG_LEVEL}

# --- Public identity ---
PUBLIC_HOST=${PUBLIC_HOST}
ALLOWED_ORIGINS=${ALLOWED_ORIGINS}

# --- Postgres ---
POSTGRES_USER=${POSTGRES_USER}
POSTGRES_DB=${POSTGRES_DB}

# --- SearXNG ---
SEARXNG_SECRET=${searxng_secret}
SEARXNG_OUTGOING_PROXIES=${SEARXNG_OUTGOING_PROXIES}

# --- Caddy / TLS ---
PUBLIC_SCHEME=${PUBLIC_SCHEME}
HTTP_PORT=${HTTP_PORT}
HTTPS_PORT=${HTTPS_PORT}

# --- Image pinning ---
GHCR_OWNER=banald
ECHO_IMAGE_TAG=${IMAGE_TAG}
ECHO_PULL_POLICY=always

# --- Limits (compose defaults are fine; override here if you need to) ---
DATABASE_POOL_MAX=10
RATE_LIMIT_DEFAULT_PER_MINUTE=60
SHUTDOWN_TIMEOUT_MS=30000

# --- Outbound proxy rotation (optional) ---
# PROXY_URLS is a comma-separated list of http(s) proxy URLs the
# mcp-server + mcp-worker processes rotate across for every external
# fetch. Empty = feature disabled. See docs/ARCHITECTURE.md "Proxy
# egress" for the full semantics.
PROXY_URLS=${PROXY_URLS}
PROXY_ROTATION=${PROXY_ROTATION:-round-robin}
PROXY_FAILURE_COOLDOWN_MS=60000
PROXY_MAX_RETRIES_PER_REQUEST=3
PROXY_CONNECT_TIMEOUT_MS=10000
EOF
}

# --- Proxy wizard ----------------------------------------------------------

phase_proxy_wizard() {
    log_step "Optional: outbound proxy rotation"

    # Flag short-circuits: --no-proxy or explicit --proxy-urls="" mean
    # "don't enable proxies". An existing PROXY_URLS value is treated as
    # the default answer in re-runs.
    if [ "$NO_PROXY_FLAG" -eq 1 ]; then
        PROXY_URLS=""
        PROXY_ROTATION="${PROXY_ROTATION:-round-robin}"
        # Only clear SEARXNG_OUTGOING_PROXIES if the operator didn't
        # explicitly supply --searxng-proxies — that flag is allowed to
        # diverge from the server-side pool.
        if [ "$SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
            SEARXNG_OUTGOING_PROXIES=""
        fi
        log_info "proxy rotation disabled (--no-proxy)"
        return 0
    fi

    # If PROXY_URLS is non-empty already (from a flag or existing .env),
    # skip the yes/no prompt. The operator has already chosen.
    local skip_prompt=0
    if [ -n "$PROXY_URLS" ]; then
        skip_prompt=1
    fi

    if [ "$skip_prompt" -eq 0 ]; then
        if [ "$NON_INTERACTIVE" -eq 1 ]; then
            # --non-interactive with no --proxy-urls and no existing
            # value → feature stays off. The operator can always re-run
            # with --proxy-urls later.
            PROXY_URLS=""
            PROXY_ROTATION="${PROXY_ROTATION:-round-robin}"
            if [ "$SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
                SEARXNG_OUTGOING_PROXIES=""
            fi
            log_info "proxy rotation not configured (--non-interactive without --proxy-urls)"
            return 0
        fi
        if ! prompt_yesno "Route outbound HTTP through rotating proxies? Useful when SearXNG engines or upstream APIs rate-limit by IP." n; then
            PROXY_URLS=""
            PROXY_ROTATION="${PROXY_ROTATION:-round-robin}"
            if [ "$SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
                SEARXNG_OUTGOING_PROXIES=""
            fi
            log_info "proxy rotation skipped"
            return 0
        fi
    fi

    # Collect + validate PROXY_URLS.
    while true; do
        local current="$PROXY_URLS"
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
            read -r -p "${C_CYAN}?${C_RESET} Comma-separated proxy URLs (http://user:pass@host:port,...): " current
        fi
        if [ -z "$current" ]; then
            log_warn "proxy URL list cannot be empty when the feature is enabled"
            continue
        fi
        if validate_proxy_csv "$current"; then
            PROXY_URLS="$current"
            break
        fi
    done
    log_info "proxies configured: $(mask_proxy_url_csv "$PROXY_URLS")"

    # Rotation strategy.
    local default_rotation="${PROXY_ROTATION:-round-robin}"
    PROXY_ROTATION=""
    prompt PROXY_ROTATION "Rotation strategy (round-robin | random)" "$default_rotation" validate_rotation

    # SearXNG proxies: default to the same list so the common "rotate
    # everything" case is a single prompt. Offer the operator a chance
    # to use a different list (or leave SearXNG on direct).
    if [ "$SEARXNG_OUTGOING_PROXIES_SET" -eq 0 ]; then
        if [ "$NON_INTERACTIVE" -eq 1 ]; then
            SEARXNG_OUTGOING_PROXIES="$PROXY_URLS"
        elif prompt_yesno "Use the same proxies for SearXNG's engine scrapers?" y; then
            SEARXNG_OUTGOING_PROXIES="$PROXY_URLS"
        else
            local searxng_input=""
            read -r -p "${C_CYAN}?${C_RESET} SearXNG proxy URLs (blank = direct egress): " searxng_input
            if [ -n "$searxng_input" ] && ! validate_proxy_csv "$searxng_input"; then
                log_warn "invalid SearXNG proxy list; falling back to direct egress"
                SEARXNG_OUTGOING_PROXIES=""
            else
                SEARXNG_OUTGOING_PROXIES="$searxng_input"
            fi
        fi
        SEARXNG_OUTGOING_PROXIES_SET=1
    fi
    if [ -n "$SEARXNG_OUTGOING_PROXIES" ]; then
        log_info "SearXNG proxies: $(mask_proxy_url_csv "$SEARXNG_OUTGOING_PROXIES")"
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
    ( cd "$ECHO_HOME" && docker compose pull --quiet ) || die "docker compose pull failed"
    ( cd "$ECHO_HOME" && docker compose up -d ) || die "docker compose up failed"

    log_info "waiting up to ${HEALTHCHECK_TIMEOUT_SECONDS}s for services to become healthy…"
    if wait_for_healthy; then
        log_ok "stack is up and healthy"
    else
        log_warn "stack did not reach healthy state within ${HEALTHCHECK_TIMEOUT_SECONDS}s"
    fi
}

# Returns 0 when every service with a healthcheck is "healthy" AND no
# service is in a failed state. Returns 1 on timeout.
wait_for_healthy() {
    local deadline=$((SECONDS + HEALTHCHECK_TIMEOUT_SECONDS))
    while [ "$SECONDS" -lt "$deadline" ]; do
        if compose_all_healthy; then
            return 0
        fi
        sleep 3
    done
    return 1
}

compose_all_healthy() {
    local json
    json="$(cd "$ECHO_HOME" && docker compose ps --format json 2>/dev/null)"
    [ -n "$json" ] || return 1

    # docker compose v2 emits NDJSON (one per service). Parse with python if
    # available, else bail and assume healthy once the healthcheck window
    # has passed — the caller will surface diagnostics on timeout anyway.
    local unhealthy=0
    while IFS= read -r line; do
        [ -z "$line" ] && continue
        # Fields: Name, Service, State, Health (may be empty string)
        local state health
        state="$(printf '%s' "$line" | sed -n 's/.*"State":"\([^"]*\)".*/\1/p')"
        health="$(printf '%s' "$line" | sed -n 's/.*"Health":"\([^"]*\)".*/\1/p')"
        # migrate service exits after running — exit 0 is success, not failure.
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
    combined="$(cd "$ECHO_HOME" && docker compose logs --no-color --tail 200 2>&1 || true)"

    if grep -qiE 'bind: address already in use' <<< "$combined"; then
        remediate_port_conflict "$combined" && retry_compose_up && return 0
    fi

    if grep -qiE 'password authentication failed' <<< "$combined"; then
        remediate_postgres_password_mismatch && retry_compose_up && return 0
    fi

    if grep -qiE 'migrate .* exited with code [1-9]' <<< "$combined" \
       || (cd "$ECHO_HOME" && docker compose ps --format json 2>/dev/null \
           | grep -q '"Service":"migrate"' \
           && cd "$ECHO_HOME" && docker compose ps migrate --format json 2>/dev/null \
           | grep -q '"ExitCode":[1-9]'); then
        log_error "migrations failed. Last 80 lines:"
        ( cd "$ECHO_HOME" && docker compose logs --no-color --tail 80 migrate ) >&2 || true
        log_error "manual recovery: see docs/OPERATIONS.md — Database migrations."
    fi

    log_error "one or more services are unhealthy after ${HEALTHCHECK_TIMEOUT_SECONDS}s"
    ( cd "$ECHO_HOME" && docker compose ps ) >&2
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
    read -r -p "choice [a/b/c]: " choice
    case "${choice,,}" in
        a)
            local new_port
            read -r -p "new port (e.g. 8443): " new_port
            validate_port "$new_port" || return 1
            if [ "${collided_port:-0}" = "${HTTPS_PORT:-0}" ]; then
                HTTPS_PORT="$new_port"
                sed -i "s/^HTTPS_PORT=.*/HTTPS_PORT=${new_port}/" "$ECHO_HOME/.env"
            else
                HTTP_PORT="$new_port"
                sed -i "s/^HTTP_PORT=.*/HTTP_PORT=${new_port}/" "$ECHO_HOME/.env"
            fi
            log_info "updated .env; will retry compose up"
            return 0
            ;;
        b)
            read -r -p "press Enter when the port is free " _
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
    read -r -p "choice [a/b/c]: " choice
    case "${choice,,}" in
        a)
            if ! prompt_yesno "are you SURE you want to destroy all Echo data?" n; then
                return 1
            fi
            if ! prompt_yesno "once more — this is destructive. Continue?" n; then
                return 1
            fi
            ( cd "$ECHO_HOME" && docker compose down -v ) || return 1
            log_info "pgdata volume destroyed; retrying up…"
            return 0
            ;;
        b)
            local pw
            prompt_secret pw "paste the original postgres password"
            [ -n "$pw" ] || return 1
            printf '%s\n' "$pw" > "$ECHO_HOME/secrets/postgres_password.txt"
            chmod 0644 "$ECHO_HOME/secrets/postgres_password.txt"
            log_info "postgres_password.txt restored; retrying up…"
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

retry_compose_up() {
    log_info "retrying docker compose up -d"
    ( cd "$ECHO_HOME" && docker compose up -d ) || return 1
    wait_for_healthy || return 1
    return 0
}

# --- Install emcp CLI ------------------------------------------------------

phase_install_emcp() {
    log_step "Install the 'emcp' command"

    mkdir -p "$(dirname "$EMCP_CONFIG_PATH")"
    cat > "$EMCP_CONFIG_PATH" <<EOF
# Managed by install.sh ($ECHO_INSTALLER_VERSION).
ECHO_HOME=${ECHO_HOME}
EOF
    chmod 0644 "$EMCP_CONFIG_PATH"

    local emcp_src
    if [ -n "$FROM_LOCAL" ] && [ -f "$FROM_LOCAL/scripts/emcp" ]; then
        emcp_src="$FROM_LOCAL/scripts/emcp"
    elif [ -f "$ECHO_HOME/scripts/emcp" ]; then
        emcp_src="$ECHO_HOME/scripts/emcp"
    else
        # Fallback: fetch the tagged copy from GitHub raw.
        local url="https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${TAG}/scripts/emcp"
        emcp_src="$(mktemp)"
        if ! curl -fsSL "$url" -o "$emcp_src"; then
            die "cannot locate scripts/emcp (not in source tree; raw download from $url failed)"
        fi
    fi

    install -D -m 0755 "$emcp_src" "$EMCP_BIN_PATH"

    # Also save this installer inside $ECHO_HOME so `emcp config` and
    # `emcp uninstall` can re-run it later. `curl | sudo bash` streams the
    # script from stdin and `$0` is the shell itself (not a file on disk),
    # so refetch from the release in that case.
    save_installer_copy

    log_ok "emcp installed at $EMCP_BIN_PATH (config at $EMCP_CONFIG_PATH)"
}

save_installer_copy() {
    local dest="$ECHO_HOME/$INSTALLER_SAVE_PATH_REL"
    mkdir -p "$(dirname "$dest")"
    if [ -f "$0" ] && head -n1 "$0" 2>/dev/null | grep -q '^#!'; then
        cp -f "$0" "$dest"
        chmod 0755 "$dest"
        return 0
    fi
    # Piped-from-curl path: refetch from the release, then raw as fallback.
    local urls=(
        "https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/${TAG}/install.sh"
        "https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${TAG}/scripts/install.sh"
    )
    for url in "${urls[@]}"; do
        if curl -fsSL "$url" -o "$dest" 2>/dev/null; then
            chmod 0755 "$dest"
            return 0
        fi
    done
    log_warn "could not save installer copy at $dest; 'emcp config' and 'emcp uninstall' will need install.sh re-downloaded"
}

# --- First API key ---------------------------------------------------------

phase_first_key() {
    if [ "$SKIP_FIRST_KEY" -eq 1 ]; then
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

    ( cd "$ECHO_HOME" && docker compose run --rm mcp-server \
        node dist/cli/keys.js create --name "$name" ) || {
        log_error "key creation failed; you can retry with: emcp key create --name \"$name\""
        return 0
    }
    log_warn "the raw key above is shown ONCE — save it now."
}

# --- Summary ---------------------------------------------------------------

phase_summary() {
    log_step "Done"
    local endpoint
    if [ "$PUBLIC_SCHEME" = "https" ] && [ "${HTTPS_PORT:-443}" = "443" ]; then
        endpoint="https://${PUBLIC_HOST}/mcp"
    elif [ "$PUBLIC_SCHEME" = "https" ]; then
        endpoint="https://${PUBLIC_HOST}:${HTTPS_PORT}/mcp"
    elif [ "${HTTP_PORT:-80}" = "80" ]; then
        endpoint="http://${PUBLIC_HOST}/mcp"
    else
        endpoint="http://${PUBLIC_HOST}:${HTTP_PORT}/mcp"
    fi

    cat <<EOF >&2

Echo is running.

  MCP endpoint:   ${C_BOLD}${endpoint}${C_RESET}
  Install dir:    ${ECHO_HOME}
  Installer tag:  ${ECHO_INSTALLER_VERSION}

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

Full docs: https://github.com/${REPO_OWNER}/${REPO_NAME}/blob/${TAG}/docs/OPERATIONS.md

EOF
}

# --- Uninstall -------------------------------------------------------------

phase_uninstall() {
    log_step "Uninstall Echo"
    if ! prompt_yesno "this will stop the stack, delete $ECHO_HOME, remove $EMCP_BIN_PATH, and wipe all data volumes. Continue?" n; then
        die "aborted"
    fi
    if ! prompt_yesno "are you SURE? This destroys the database." n; then
        die "aborted"
    fi
    if [ -f "$ECHO_HOME/compose.yaml" ]; then
        ( cd "$ECHO_HOME" && docker compose down -v ) || log_warn "compose down -v returned non-zero"
    fi
    rm -rf "$ECHO_HOME"
    rm -f "$EMCP_BIN_PATH" "$EMCP_CONFIG_PATH"
    rmdir "$(dirname "$EMCP_CONFIG_PATH")" 2>/dev/null || true
    log_ok "Echo uninstalled."
}

# --- Reconfigure -----------------------------------------------------------

phase_reconfigure() {
    [ -f "$ECHO_HOME/compose.yaml" ] || die "no existing install at $ECHO_HOME (run install.sh first)"
    log_step "Reconfigure $ECHO_HOME/.env"
    phase_env_wizard
    phase_proxy_wizard
    log_info "restarting stack to pick up new .env"
    ( cd "$ECHO_HOME" && docker compose up -d ) || die "docker compose up failed"
    wait_for_healthy && log_ok "stack healthy" || phase_postflight_detection
}

# --- Main ------------------------------------------------------------------

main() {
    parse_args "$@"

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
    phase_install_emcp
    phase_first_key
    phase_summary
}

main "$@"
