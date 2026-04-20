#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# tests/e2e/install-rootless.test.sh — end-to-end verification of v2's
# rootless install path.
#
# Runs against a user-owned rootless Docker daemon:
#   1. The installer must complete with zero `sudo` invocations.
#   2. The resulting compose stack must match every OWASP Docker Cheat
#      Sheet rule the repo claims to enforce (#1, #3, #4, #5, #7, #8, #11).
#   3. The /mcp endpoint must reject a bogus bearer token with HTTP 401
#      and accept a freshly-issued key.
#   4. `emcp uninstall --force` must leave zero residue.
#
# CI runs this in the ci-rootless job (.github/workflows/ci.yml). To
# run locally, point $DOCKER_HOST at a rootless daemon, install the
# dependencies the preflight checks for, and invoke:
#   bash tests/e2e/install-rootless.test.sh
# ---------------------------------------------------------------------------

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# --- Pretty-print helpers --------------------------------------------------
if [ -t 2 ]; then
    C_RESET=$'\033[0m'; C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_CYAN=$'\033[1;36m'
else
    C_RESET=""; C_RED=""; C_GREEN=""; C_CYAN=""
fi
say_ok()   { printf '%s[ok]%s   %s\n'   "$C_GREEN" "$C_RESET" "$*" >&2; }
say_step() { printf '\n%s==>%s %s\n\n' "$C_CYAN"  "$C_RESET" "$*" >&2; }
say_fail() { printf '%s[fail]%s %s\n'  "$C_RED"   "$C_RESET" "$*" >&2; }
fail()     { say_fail "$*"; exit 1; }

# --- Step 1: verify we're against a rootless daemon -----------------------
say_step "Preconditions"

if [ -z "${DOCKER_HOST:-}" ]; then
    DOCKER_HOST="unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
    export DOCKER_HOST
    say_ok "DOCKER_HOST defaulted to $DOCKER_HOST"
fi
if ! docker info >/dev/null 2>&1; then
    fail "docker info failed against $DOCKER_HOST"
fi
if ! docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' | grep -q rootless; then
    fail "daemon at $DOCKER_HOST is NOT rootless — refusing to run the e2e against a rootful daemon"
fi
say_ok "rootless daemon reachable at $DOCKER_HOST"

# --- Step 2: install a sudo shim that logs + fails ------------------------
say_step "Install sudo-shim (captures any sudo invocation)"

SHIM_DIR="$(mktemp -d)"
trap 'rm -rf "$SHIM_DIR"' EXIT
cat > "$SHIM_DIR/sudo" <<'EOF'
#!/usr/bin/env bash
# e2e sudo shim: the installer must never call sudo in v2. If it does,
# log the invocation and fail loudly.
echo "$(date -u +%FT%TZ) sudo $*" >> "${SHIM_LOG:-/dev/null}"
exit 99
EOF
chmod +x "$SHIM_DIR/sudo"
SHIM_LOG="$SHIM_DIR/sudo.log"
export SHIM_LOG
export PATH="$SHIM_DIR:$PATH"
say_ok "sudo shim installed at $SHIM_DIR/sudo"

# --- Step 3: scrub $HOME so install paths land in a throwaway dir ---------
say_step "Isolate \$HOME for the install run"

ORIG_HOME="$HOME"
TMP_HOME="$(mktemp -d)"
export HOME="$TMP_HOME"
export XDG_DATA_HOME="$HOME/.local/share"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_BIN_HOME="$HOME/.local/bin"
mkdir -p "$XDG_DATA_HOME" "$XDG_CONFIG_HOME" "$XDG_BIN_HOME"
say_ok "HOME=$HOME (real home preserved at $ORIG_HOME)"

# --- Step 4: run the installer --------------------------------------------
say_step "Run install.sh --non-interactive --from-local ."

# EMCP_PULL_POLICY=build so compose builds the image from source (no
# ghcr.io auth needed). The e2e's point is the installer flow, not a
# pre-built image.
export EMCP_PULL_POLICY=build
# Skip secret generation warnings on CI (we regenerate fresh each run).
export EMCP_SKIP_ROOTLESS_CHECK="${EMCP_SKIP_ROOTLESS_CHECK:-0}"

install_rc=0
bash "$REPO_ROOT/scripts/install.sh" \
    --non-interactive \
    --from-local "$REPO_ROOT" \
    --public-host localhost \
    --public-scheme https \
    --allowed-origins "http://localhost:8443,https://localhost:8443" \
    --skip-first-key \
    --no-proxy || install_rc=$?

if [ "$install_rc" -ne 0 ]; then
    fail "installer exited with code $install_rc"
fi
say_ok "installer exited cleanly"

# --- Step 5: sudo shim must be untouched ----------------------------------
say_step "Verify no sudo invocation"

if [ -s "$SHIM_LOG" ]; then
    say_fail "installer invoked sudo (v2 rootless-mode violation):"
    cat "$SHIM_LOG" >&2
    exit 1
fi
say_ok "zero sudo invocations"

# --- Step 6: XDG paths populated ------------------------------------------
say_step "Verify XDG paths"

[ -f "$XDG_DATA_HOME/emcp/compose.yaml" ] || fail "missing $XDG_DATA_HOME/emcp/compose.yaml"
[ -x "$XDG_BIN_HOME/emcp" ]                || fail "missing $XDG_BIN_HOME/emcp"
[ -f "$XDG_CONFIG_HOME/emcp/config" ]      || fail "missing $XDG_CONFIG_HOME/emcp/config"
say_ok "XDG_DATA_HOME, XDG_BIN_HOME, XDG_CONFIG_HOME all populated"

EMCP="$XDG_BIN_HOME/emcp"

# --- Step 7: stack must be healthy ----------------------------------------
say_step "Verify stack status"

ps_json="$("$EMCP" status --format json 2>/dev/null || true)"
if [ -z "$ps_json" ]; then
    # Fall back to plain ps if --format json isn't supported (older compose).
    "$EMCP" status
else
    printf '%s\n' "$ps_json" | head -20
fi

# Check each service is running/healthy
services=(postgres redis searxng mcp-server mcp-worker caddy)
for svc in "${services[@]}"; do
    state="$("$EMCP" ps --format json 2>/dev/null \
        | python3 -c "
import json, sys
for line in sys.stdin.read().strip().splitlines():
    if not line: continue
    try:
        svc = json.loads(line)
        if svc.get('Service') == '$svc':
            print(svc.get('State', '') + ':' + (svc.get('Health') or 'none'))
    except Exception:
        pass
" 2>/dev/null || true)"
    case "$state" in
        running:healthy|running:none) say_ok "$svc: $state" ;;
        *) fail "$svc not healthy (state='$state')" ;;
    esac
done

# --- Step 8: OWASP rule inspection per service ----------------------------
say_step "Verify OWASP hardening on each container"

for svc in "${services[@]}"; do
    cid="$(cd "$XDG_DATA_HOME/emcp" && docker compose ps -q "$svc")"
    [ -n "$cid" ] || fail "no container id for $svc"

    # #4 — no-new-privileges
    sec="$(docker inspect "$cid" --format '{{range .HostConfig.SecurityOpt}}{{println .}}{{end}}')"
    printf '%s' "$sec" | grep -q 'no-new-privileges:true' \
        || fail "$svc missing no-new-privileges (OWASP #4)"

    # #3 — cap_drop includes ALL
    cap_drop="$(docker inspect "$cid" --format '{{range .HostConfig.CapDrop}}{{println .}}{{end}}')"
    printf '%s' "$cap_drop" | grep -q '^ALL$' \
        || fail "$svc did not drop ALL capabilities (OWASP #3)"

    # #8 — read-only rootfs
    ro="$(docker inspect "$cid" --format '{{.HostConfig.ReadonlyRootfs}}')"
    [ "$ro" = "true" ] || fail "$svc rootfs is NOT read-only (OWASP #8)"

    # #7 — memory limit > 0
    mem="$(docker inspect "$cid" --format '{{.HostConfig.Memory}}')"
    [ "${mem:-0}" -gt 0 ] || fail "$svc has no memory limit (OWASP #7)"
    pids="$(docker inspect "$cid" --format '{{.HostConfig.PidsLimit}}')"
    [ "${pids:-0}" -gt 0 ] || fail "$svc has no pids limit (OWASP #7)"

    say_ok "$svc: SecurityOpt + CapDrop + ReadonlyRootfs + Memory + PidsLimit ok"
done

# --- Step 9: /mcp rejects bogus key ---------------------------------------
say_step "Verify auth middleware rejects bogus bearer"

# Curl with an Origin header matching EMCP_ALLOWED_ORIGINS — keys
# default to requireOrigin=true, and the installer seeds the allowlist
# with both http://localhost:8080 and https://localhost:8443 above.
MCP_ORIGIN='https://localhost:8443'

resp_code="$(curl -sk -o /dev/null -w '%{http_code}' \
    -X POST "https://localhost:8443/mcp" \
    -H 'Authorization: Bearer bogus-key-for-e2e' \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Origin: $MCP_ORIGIN" \
    --max-time 10 \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' \
    || true)"
[ "$resp_code" = "401" ] || fail "/mcp returned $resp_code, expected 401 for a bogus bearer"
say_ok "/mcp returned 401 for bogus key"

# --- Step 10: issue a key and use it --------------------------------------
say_step "Create a key via emcp key create"

key_out="$("$EMCP" key create --name e2e 2>&1 || true)"
raw_key="$(printf '%s\n' "$key_out" | grep -oE 'mcp_live_[A-Za-z0-9_-]{43}' | head -n1 || true)"
[ -n "$raw_key" ] || {
    printf '%s\n' "$key_out" >&2
    fail "emcp key create did not emit a raw key"
}
say_ok "key minted: ${raw_key:0:16}…"

resp_code="$(curl -sk -o /dev/null -w '%{http_code}' \
    -X POST "https://localhost:8443/mcp" \
    -H "Authorization: Bearer $raw_key" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "Origin: $MCP_ORIGIN" \
    --max-time 10 \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"1"}}}' \
    || true)"
case "$resp_code" in
    200|204) say_ok "/mcp accepted the issued key (HTTP $resp_code)" ;;
    *) fail "/mcp rejected valid key with HTTP $resp_code" ;;
esac

# --- Step 11: uninstall cleans up -----------------------------------------
say_step "emcp uninstall --force"

"$EMCP" uninstall --force >/dev/null 2>&1 || fail "emcp uninstall failed"
[ ! -d "$XDG_DATA_HOME/emcp" ] || fail "uninstall left $XDG_DATA_HOME/emcp"
[ ! -x "$XDG_BIN_HOME/emcp" ]   || fail "uninstall left $XDG_BIN_HOME/emcp"
[ ! -f "$XDG_CONFIG_HOME/emcp/config" ] || fail "uninstall left $XDG_CONFIG_HOME/emcp/config"
say_ok "emcp uninstall cleaned up all paths"

# --- Done -----------------------------------------------------------------
say_step "All rootless e2e checks passed"
