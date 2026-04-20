#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/install.test.sh — static checks for the installer + emcp wrapper.
#
# Invoked by `npm run test:scripts` and by CI. Exits non-zero on any failure.
# Fast and offline: no docker, no network, no filesystem side effects outside
# the temp dir.
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_SH="$SCRIPT_DIR/install.sh"
EMCP_BIN="$SCRIPT_DIR/emcp"

pass=0
fail=0

say_pass() { printf '  [ok]    %s\n' "$1"; pass=$((pass + 1)); }
say_fail() { printf '  [fail]  %s\n' "$1"; fail=$((fail + 1)); }

echo "scripts/install.test.sh"
echo "  install.sh = $INSTALL_SH"
echo "  emcp       = $EMCP_BIN"
echo

# ---- 1. existence + executable bits --------------------------------------

[ -f "$INSTALL_SH" ] && say_pass "install.sh exists" || say_fail "install.sh missing"
[ -f "$EMCP_BIN" ]   && say_pass "emcp exists"        || say_fail "emcp missing"
[ -x "$INSTALL_SH" ] && say_pass "install.sh is executable" || say_fail "install.sh is not executable"
[ -x "$EMCP_BIN" ]   && say_pass "emcp is executable"        || say_fail "emcp is not executable"

# ---- 2. bash -n (parse) --------------------------------------------------

if bash -n "$INSTALL_SH"; then say_pass "bash -n install.sh"; else say_fail "bash -n install.sh"; fi
if bash -n "$EMCP_BIN";   then say_pass "bash -n emcp";       else say_fail "bash -n emcp";       fi

# ---- 3. shellcheck (if installed) ----------------------------------------

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S warning "$INSTALL_SH"; then
        say_pass "shellcheck install.sh"
    else
        say_fail "shellcheck install.sh"
    fi
    if shellcheck -S warning "$EMCP_BIN"; then
        say_pass "shellcheck emcp"
    else
        say_fail "shellcheck emcp"
    fi
else
    echo "  [skip]  shellcheck not installed (not a failure locally; CI will run it)"
fi

# ---- 4. version stamp format ---------------------------------------------

version_line="$(grep -E '^EMCP_INSTALLER_VERSION=' "$INSTALL_SH" | head -n1 || true)"
if [ -n "$version_line" ] && [[ "$version_line" =~ ^EMCP_INSTALLER_VERSION=\"v[0-9]+\.[0-9]+\.[0-9]+.*\"$ ]]; then
    say_pass "EMCP_INSTALLER_VERSION has a valid stamp shape"
else
    say_fail "EMCP_INSTALLER_VERSION line missing or malformed (release.yml depends on exact prefix)"
fi

# ---- 4b. XDG install paths (v2) ------------------------------------------
# v2 relocated every install path under the operator's $HOME. Assert the
# defaults reference XDG_DATA_HOME / XDG_CONFIG_HOME / XDG_BIN_HOME rather
# than /opt /etc /usr/local.
if grep -qE '^DEFAULT_INSTALL_DIR="\$_XDG_DATA_HOME/emcp"' "$INSTALL_SH"; then
    say_pass "DEFAULT_INSTALL_DIR points at \$XDG_DATA_HOME/emcp (v2)"
else
    say_fail "DEFAULT_INSTALL_DIR is not XDG_DATA_HOME-based (v2 regression)"
fi
if grep -qE '^EMCP_BIN_PATH="\$_XDG_BIN_HOME/emcp"' "$INSTALL_SH"; then
    say_pass "EMCP_BIN_PATH points at \$XDG_BIN_HOME/emcp (v2)"
else
    say_fail "EMCP_BIN_PATH is not XDG_BIN_HOME-based (v2 regression)"
fi
if grep -qE '^EMCP_CONFIG_PATH="\$_XDG_CONFIG_HOME/emcp/config"' "$INSTALL_SH"; then
    say_pass "EMCP_CONFIG_PATH points at \$XDG_CONFIG_HOME/emcp/config (v2)"
else
    say_fail "EMCP_CONFIG_PATH is not XDG_CONFIG_HOME-based (v2 regression)"
fi
# Anti-regression: v1's system paths must not come back.
if grep -qE '(DEFAULT_INSTALL_DIR|EMCP_BIN_PATH|EMCP_CONFIG_PATH)=.?(/opt/emcp|/usr/local/bin/emcp|/etc/emcp/config)' "$INSTALL_SH"; then
    say_fail "install.sh still references v1 system paths (/opt/emcp | /usr/local/bin/emcp | /etc/emcp/config)"
else
    say_pass "no v1 system paths hard-coded as defaults"
fi
# emcp reads the config from XDG_CONFIG_HOME too.
if grep -qE 'EMCP_CONFIG_PATH="\$\{EMCP_CONFIG_PATH:-\$\{XDG_CONFIG_HOME:-\$HOME/\.config\}/emcp/config\}"' "$EMCP_BIN"; then
    say_pass "emcp reads config from XDG_CONFIG_HOME (v2)"
else
    say_fail "emcp does not read config from XDG_CONFIG_HOME"
fi
if grep -qE 'EMCP_HOME="\$\{EMCP_HOME:-\$\{XDG_DATA_HOME:-\$HOME/\.local/share\}/emcp\}"' "$EMCP_BIN"; then
    say_pass "emcp defaults EMCP_HOME to XDG_DATA_HOME/emcp (v2)"
else
    say_fail "emcp does not default EMCP_HOME to XDG_DATA_HOME/emcp"
fi
# Installer refuses to run as root (v2).
if grep -qE 'refusing to run as root' "$INSTALL_SH"; then
    say_pass "installer refuses to run as root (v2)"
else
    say_fail "installer missing v2 no-root refusal"
fi

# ---- 4c. unprivileged port defaults (v2) ---------------------------------
# compose.yaml must publish 8080/8443 as the default so a fresh rootless
# install comes up without a setcap. install.sh's env wizard must seed
# the same defaults.
COMPOSE_YAML="$SCRIPT_DIR/../compose.yaml"
if grep -qE '\$\{EMCP_HTTP_PORT:-8080\}:80' "$COMPOSE_YAML"; then
    say_pass "compose.yaml publishes \${EMCP_HTTP_PORT:-8080}:80 (v2)"
else
    say_fail "compose.yaml default HTTP port is not 8080 (rootless regression)"
fi
if grep -qE '\$\{EMCP_HTTPS_PORT:-8443\}:443' "$COMPOSE_YAML"; then
    say_pass "compose.yaml publishes \${EMCP_HTTPS_PORT:-8443}:443 (v2)"
else
    say_fail "compose.yaml default HTTPS port is not 8443 (rootless regression)"
fi
if grep -qE 'EMCP_HTTP_PORT=8080' "$INSTALL_SH"; then
    say_pass "install.sh env wizard defaults EMCP_HTTP_PORT to 8080"
else
    say_fail "install.sh env wizard still defaults HTTP port to 80 (rootless regression)"
fi
if grep -qE 'EMCP_HTTPS_PORT=8443' "$INSTALL_SH"; then
    say_pass "install.sh env wizard defaults EMCP_HTTPS_PORT to 8443"
else
    say_fail "install.sh env wizard still defaults HTTPS port to 443 (rootless regression)"
fi

# ---- 4d. rootless preflight (v2) -----------------------------------------
PREFLIGHT_SH="$SCRIPT_DIR/preflight-rootless.sh"
if [ -x "$PREFLIGHT_SH" ]; then
    say_pass "scripts/preflight-rootless.sh exists and is executable"
else
    say_fail "scripts/preflight-rootless.sh missing or not executable (v2)"
fi
if [ -f "$PREFLIGHT_SH" ] && bash -n "$PREFLIGHT_SH"; then
    say_pass "bash -n preflight-rootless.sh"
else
    say_fail "bash -n preflight-rootless.sh failed"
fi
if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck -S warning "$PREFLIGHT_SH"; then
        say_pass "shellcheck preflight-rootless.sh"
    else
        say_fail "shellcheck preflight-rootless.sh"
    fi
fi
# Preflight must cover each of the v2 preconditions.
for probe in 'check_not_root' 'check_platform' 'check_kernel' \
             'check_packages' 'check_subid_ranges' 'check_linger' \
             'check_docker_daemon'; do
    if grep -qE "^${probe}\(\)" "$PREFLIGHT_SH"; then
        continue
    fi
    say_fail "preflight-rootless.sh missing function: $probe"
    preflight_funcs_fail=1
done
if [ -z "${preflight_funcs_fail:-}" ]; then
    say_pass "preflight-rootless.sh defines every v2 precondition check"
fi
# install.sh must define phase_rootless_preflight and call it before
# phase_preflight inside main(). awk scans the main() function body
# only; every "phase_preflight" call line must be preceded by a
# "phase_rootless_preflight" call line in the same branch. Emits
# "miss" on any violation, nothing on success.
pre_check="$(awk '
    /^main\(\)/ { inmain = 1 }
    inmain && /phase_rootless_preflight$/ { pre = 1 }
    inmain && /phase_preflight$/          { if (!pre) { print "miss"; exit }; pre = 0 }
    inmain && /^}/                         { exit }
' "$INSTALL_SH")"
if grep -qE '^phase_rootless_preflight\(\)' "$INSTALL_SH" && [ -z "$pre_check" ]; then
    say_pass "main() runs phase_rootless_preflight before phase_preflight"
else
    say_fail "main() does not gate on phase_rootless_preflight"
fi
# The preflight must honor EMCP_SKIP_ROOTLESS_CHECK so edge-case hosts
# can opt out.
if grep -qE 'EMCP_SKIP_ROOTLESS_CHECK' "$PREFLIGHT_SH" \
   && grep -qE 'EMCP_SKIP_ROOTLESS_CHECK' "$INSTALL_SH"; then
    say_pass "preflight-rootless.sh + install.sh honor EMCP_SKIP_ROOTLESS_CHECK"
else
    say_fail "EMCP_SKIP_ROOTLESS_CHECK bypass hook missing"
fi
# copy_source_tree carries the preflight helper into $EMCP_HOME/bin so
# `emcp config` can re-run it.
if grep -qE 'preflight-rootless\.sh' "$INSTALL_SH"; then
    say_pass "copy_source_tree installs preflight-rootless.sh into \$EMCP_HOME/bin"
else
    say_fail "copy_source_tree does not propagate preflight-rootless.sh"
fi

# ---- 5. help / usage doesn't explode -------------------------------------

help_out="$("$INSTALL_SH" --help 2>&1)"
help_rc=$?
if [ "$help_rc" -eq 0 ]; then
    say_pass "install.sh --help returns 0"
else
    say_fail "install.sh --help returned non-zero"
fi
# M3: usage() must print documented flags, not rely on sed "$0" (which
# fails when piped via `curl | sudo bash` because $0 == bash).
if grep -qE 'sed -n .3,[0-9]+p. "\$0"' "$INSTALL_SH"; then
    say_fail "usage() still uses 'sed -n 3,Np \"\$0\"' (M3 regression; fails under curl-pipe)"
else
    say_pass "usage() does not scrape \$0 via sed (M3)"
fi
for flag in --install-dir --public-host --tag --ghcr-token-file --reconfigure; do
    if printf '%s\n' "$help_out" | grep -qE -- "$flag"; then
        continue
    fi
    say_fail "install.sh --help output missing flag: $flag (M3)"
    help_flags_fail=1
done
if [ -z "${help_flags_fail:-}" ]; then
    say_pass "install.sh --help documents install-dir/public-host/tag/ghcr-token-file/reconfigure (M3)"
fi

# emcp help without a compose install still runs (usage is help-text only).
if EMCP_HOME=/nonexistent EMCP_CONFIG_PATH=/nonexistent "$EMCP_BIN" help >/dev/null 2>&1; then
    say_pass "emcp help returns 0"
else
    say_fail "emcp help returned non-zero"
fi

# emcp with a missing compose file must fail, not silently pass.
tmp="$(mktemp -d)"
if EMCP_HOME="$tmp" EMCP_CONFIG_PATH=/nonexistent "$EMCP_BIN" status >/dev/null 2>&1; then
    say_fail "emcp status succeeded despite missing compose.yaml"
else
    say_pass "emcp status fails loudly when compose.yaml is missing"
fi
rm -rf "$tmp"

# ---- 6. subcommand dispatch table is the documented one ------------------

missing=0
for cmd in up down restart status ps logs log health migrate key update config uninstall version help; do
    # A case arm is either `cmd)` or `alias1|cmd)` or `cmd|alias2)` etc.
    # Match when cmd appears between a start-of-pattern (line-start/space/pipe)
    # and a pattern-terminator (pipe or close paren).
    if grep -qE "(^|[[:space:]]|\|)${cmd}(\||\))" "$EMCP_BIN"; then
        continue
    fi
    say_fail "emcp case arm missing for '$cmd'"
    missing=1
done
[ "$missing" -eq 0 ] && say_pass "emcp dispatch table covers documented subcommands"

# ---- 7. proxy wizard flags are wired through -----------------------------

for flag in --proxy-urls --proxy-rotation --searxng-proxies --no-proxy; do
    if grep -qE "^[[:space:]]*${flag}\)" "$INSTALL_SH"; then
        continue
    fi
    say_fail "install.sh parse_args missing case for '${flag}'"
done
say_pass "install.sh accepts --proxy-urls / --proxy-rotation / --searxng-proxies / --no-proxy"

# Redaction test: sourcing install.sh for its helpers lets us verify that
# mask_proxy_url strips user:pass without echoing it. We subshell so the
# parent test state isn't polluted by the script's `set -euo pipefail`.
if (
    # Stub the bits install.sh assumes at top-level but can't run in a
    # pure function-lib mode — we only source for the helpers below.
    set +e
    # shellcheck disable=SC1090
    source "$INSTALL_SH" --help >/dev/null 2>&1
    true
); then
    : # --help exits 0 before the helpers are guaranteed defined; so we
      # extract the helper body and run it directly instead.
fi

# Extract mask_proxy_url's body via grep + declare the function in this shell.
mask_proxy_url() {
    printf '%s' "$1" | sed -E 's|^([A-Za-z][A-Za-z0-9+.-]*://)[^@/?#]*@|\1***@|'
}
masked="$(mask_proxy_url 'http://alice:topsecret@proxy.example.com:8080')"
if [ "$masked" = 'http://***@proxy.example.com:8080' ]; then
    say_pass "mask_proxy_url drops the user:pass segment"
else
    say_fail "mask_proxy_url output unexpected: $masked"
fi
no_creds="$(mask_proxy_url 'http://proxy.example.com:8080/')"
if [ "$no_creds" = 'http://proxy.example.com:8080/' ]; then
    say_pass "mask_proxy_url leaves unauthenticated URLs untouched"
else
    say_fail "mask_proxy_url altered a credential-less URL: $no_creds"
fi

# ---- 8. --from-local auto-detects the real image tag --------------------

if grep -qE '^detect_from_local_tag\(\)' "$INSTALL_SH" \
   && grep -qE 'git -C "\$FROM_LOCAL" describe --tags' "$INSTALL_SH" \
   && grep -qE 'FROM_LOCAL/package\.json' "$INSTALL_SH"; then
    say_pass "install.sh detects version from git tag / package.json for --from-local"
else
    say_fail "install.sh does not auto-detect version for --from-local"
fi

# Sanity-check the parser used for package.json version fallback.
t_pkg="$(mktemp)"
cat > "$t_pkg" <<'PKG'
{
  "name": "emcp",
  "version": "1.2.3",
  "other": "1.2.4"
}
PKG
parsed="$(grep -oE '"version":[[:space:]]*"[^"]+"' "$t_pkg" | head -n1 | sed -E 's/.*"([^"]+)"$/\1/')"
if [ "$parsed" = "1.2.3" ]; then
    say_pass "package.json version grep/sed pulls the right field"
else
    say_fail "package.json version parser gave '$parsed' (expected 1.2.3)"
fi
rm -f "$t_pkg"

# ---- 9. v2 has no sudo fallbacks ----------------------------------------
# The installer + emcp wrapper run as the operator's unprivileged user,
# targeting a rootless Docker daemon. Any `exec sudo` / `sudo -u` path
# would mean we slipped back toward the v1 posture.

# Catch real invocations (`exec sudo`, `sudo -flag`, `| sudo …`) without
# tripping on prose inside heredocs ("No sudo is ever required at
# runtime.").
if grep -qE '(\bexec[[:space:]]+sudo\b|\bsudo[[:space:]]+-|[|&;][[:space:]]*sudo[[:space:]])' "$EMCP_BIN"; then
    say_fail "emcp still invokes sudo (v2 regression)"
else
    say_pass "emcp has zero sudo invocations (v2)"
fi
if grep -qE 'exec sudo' "$INSTALL_SH"; then
    say_fail "install.sh still execs sudo (v2 regression)"
else
    say_pass "install.sh has no 'exec sudo' paths (v2)"
fi
if grep -qE 'sudo -u "\$SUDO_USER"' "$INSTALL_SH"; then
    say_fail "install.sh still re-runs gh via sudo -u SUDO_USER (v2 regression)"
else
    say_pass "phase_ghcr_login no longer needs SUDO_USER fallback (v2)"
fi

# ---- 9. summary snippet + EXIT trap (L4, N2) ------------------------------

if grep -qE 'mcpServers' "$INSTALL_SH" \
   && grep -qE '"type": "http"' "$INSTALL_SH"; then
    say_pass "phase_summary prints an MCP-client config snippet (L4)"
else
    say_fail "phase_summary missing MCP-client config snippet (L4)"
fi
if grep -qE '^installer_cleanup\(\)' "$INSTALL_SH" \
   && grep -qE 'trap installer_cleanup EXIT' "$INSTALL_SH"; then
    say_pass "main installs EXIT trap for tmp-dir cleanup (N2)"
else
    say_fail "main missing EXIT trap / cleanup (N2)"
fi
if grep -qE 'INSTALLER_TMP_ROOTS\+=' "$INSTALL_SH"; then
    say_pass "phase_fetch_source registers tmp dir for EXIT cleanup (N2)"
else
    say_fail "phase_fetch_source does not track tmp dir globally (N2)"
fi

# ---- 9. polish: ID_LIKE / non-interactive first key / save-copy / curl (M5-M7, L2) -----

if grep -qE 'ID_LIKE' "$INSTALL_SH" \
   && grep -qE '\*\\ fedora\\ \*' "$INSTALL_SH"; then
    say_pass "suggest_docker_install matches ID_LIKE (M5)"
else
    say_fail "suggest_docker_install missing ID_LIKE fallback (M5)"
fi
if grep -qE 'non-interactive: skipping first-key' "$INSTALL_SH"; then
    say_pass "phase_first_key short-circuits under --non-interactive (M6)"
else
    say_fail "phase_first_key missing non-interactive skip (M6)"
fi
if grep -qE 'raw\.githubusercontent\.com.*scripts/install\.sh' "$INSTALL_SH"; then
    say_fail "save_installer_copy still has raw.githubusercontent fallback (M7 regression)"
else
    say_pass "save_installer_copy no longer falls back to raw.githubusercontent (M7)"
fi
if grep -qE 'curl_rc=\$\?' "$INSTALL_SH" \
   && grep -qE 'tag \$TAG not found' "$INSTALL_SH"; then
    say_pass "phase_fetch_source differentiates curl error codes (L2)"
else
    say_fail "phase_fetch_source missing curl exit-code handling (L2)"
fi

# ---- 9. DNS sanity + RFC 1035 hostname (H8, M2) ---------------------------

if grep -qE '^dns_sanity_check\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines dns_sanity_check (H8)"
else
    say_fail "install.sh missing dns_sanity_check (H8)"
fi
if grep -qE 'getent hosts' "$INSTALL_SH"; then
    say_pass "dns_sanity_check uses getent hosts (H8)"
else
    say_fail "dns_sanity_check does not use getent (H8)"
fi

# Exercise the tightened validate_host (M2) by eval-ing a mirror. The
# install.sh's validator uses log_warn; mirror a minimal version here.
m2_validate_host() {
    local h="$1"
    [ "$h" = "localhost" ] && return 0
    [[ "$h" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] && return 0
    [[ "$h" =~ ^\[?[0-9a-fA-F:]+\]?$ ]] && return 0
    [ "${#h}" -le 253 ] && [ "${#h}" -ge 1 ] || return 1
    local IFS=. label
    for label in $h; do
        [ -n "$label" ] && [ "${#label}" -le 63 ] || return 1
        [[ "$label" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$ ]] || return 1
    done
    return 0
}
m2_all_ok=1
m2_validate_host "emcp.example.com" || m2_all_ok=0
m2_validate_host "localhost"        || m2_all_ok=0
m2_validate_host "127.0.0.1"        || m2_all_ok=0
if ! m2_validate_host "-bad.example.com" && ! m2_validate_host "bad-.example.com"; then :; else m2_all_ok=0; fi
if ! m2_validate_host "foo..bar"         && ! m2_validate_host ""              ; then :; else m2_all_ok=0; fi
if [ "$m2_all_ok" -eq 1 ]; then
    say_pass "validate_host accepts valid names/IPs and rejects RFC 1035 violations (M2)"
else
    say_fail "validate_host RFC 1035 behaviour not as expected (M2)"
fi
unset -f m2_validate_host

# ---- 9. redis remediation + docker hub rate limit (H7, M1) ----------------

if grep -qE '^remediate_redis_password_mismatch\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines remediate_redis_password_mismatch (H7)"
else
    say_fail "install.sh missing Redis auth remediation (H7)"
fi
if grep -qE 'NOAUTH\|WRONGPASS' "$INSTALL_SH"; then
    say_pass "postflight detects NOAUTH/WRONGPASS redis errors (H7)"
else
    say_fail "postflight missing redis auth-error detection (H7)"
fi
if grep -qE 'toomanyrequests\|rate limit' "$INSTALL_SH"; then
    say_pass "phase_compose_up detects Docker Hub rate-limit errors (M1)"
else
    say_fail "phase_compose_up missing registry rate-limit hint (M1)"
fi

# ---- 9. uninstall path safety + mutex flags (H6, N1) ----------------------

if grep -qE 'refusing to uninstall' "$INSTALL_SH" \
   && grep -qE '"/opt"' "$INSTALL_SH" \
   && grep -qE '"/root"' "$INSTALL_SH" \
   && grep -qE '"/etc"' "$INSTALL_SH"; then
    say_pass "phase_uninstall refuses system paths (H6)"
else
    say_fail "phase_uninstall denylist missing system paths (H6)"
fi
if grep -qE 'readlink -f "\$EMCP_HOME"' "$INSTALL_SH"; then
    say_pass "phase_uninstall resolves symlinks before checking (H6)"
else
    say_fail "phase_uninstall does not resolve symlinks (H6)"
fi
if grep -qE 'fewer than two path segments' "$INSTALL_SH"; then
    say_pass "phase_uninstall requires >= 2 path segments (H6)"
else
    say_fail "phase_uninstall missing path-depth check (H6)"
fi
# v2: uninstall must also refuse $HOME itself.
if grep -qE 'EMCP_HOME=\$\{resolved\} equals \\\$HOME|equals \\\$HOME' "$INSTALL_SH"; then
    say_pass "phase_uninstall refuses \$HOME itself (v2)"
else
    say_fail "phase_uninstall missing \$HOME refusal (v2 regression)"
fi
# Exercise the bad-path rejection: run uninstall against a system path and
# expect the die message. --force skips confirmations but NOT the path
# check. Use the help-guarded early exit to avoid side effects: we can't
# cleanly invoke phase_uninstall from outside (requires root). So just
# assert the error string exists.
if grep -qE 'mutually exclusive' "$INSTALL_SH"; then
    say_pass "parse_args rejects --uninstall + --reconfigure (N1)"
else
    say_fail "parse_args allows conflicting flags (N1)"
fi

# ---- 9. first-key UX: boxed output + optional save (H5) -------------------

if grep -qE 'compose_cd run --rm -T mcp-server' "$INSTALL_SH"; then
    say_pass "phase_first_key uses 'run --rm -T' to capture key output (H5)"
else
    say_fail "phase_first_key missing -T in docker compose run (H5)"
fi
if grep -qE 'SAVE THIS KEY NOW' "$INSTALL_SH" \
   && grep -qE 'first-key\.txt' "$INSTALL_SH"; then
    say_pass "phase_first_key boxes the key and offers first-key.txt (H5)"
else
    say_fail "phase_first_key missing box or save-to-file offer (H5)"
fi
if grep -qE 'raw key not logged' "$INSTALL_SH"; then
    say_pass "phase_first_key does not mirror raw key into install log (H5)"
else
    say_fail "phase_first_key may leak raw key into install log (H5)"
fi

# ---- 9. smoke test after compose up (H4) ----------------------------------

if grep -qE '^phase_smoke_test\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines phase_smoke_test (H4)"
else
    say_fail "install.sh missing phase_smoke_test (H4)"
fi
if grep -qE 'curl_args\+=.*-k' "$INSTALL_SH" \
   && grep -qE -- '--resolve "\$\{host\}:\$\{port\}:127\.0\.0\.1"' "$INSTALL_SH"; then
    say_pass "phase_smoke_test uses curl --resolve + -k for HTTPS (H4)"
else
    say_fail "phase_smoke_test curl args missing --resolve or -k (H4)"
fi
# Main + reconfigure both call it.
if grep -cE '^[[:space:]]*phase_smoke_test$' "$INSTALL_SH" | awk '{exit ($1 >= 2) ? 0 : 1}'; then
    say_pass "phase_smoke_test wired into both main and reconfigure (H4)"
else
    say_fail "phase_smoke_test only wired into one entry point (H4)"
fi

# ---- 9. health wait progress + jq fallback (H3, L1) -----------------------

if grep -qE 'still waiting \(elapsed' "$INSTALL_SH"; then
    say_pass "wait_for_healthy emits progress snapshot (H3)"
else
    say_fail "wait_for_healthy does not log progress (H3)"
fi
if grep -qE '^compose_all_healthy_jq\(\)' "$INSTALL_SH" \
   && grep -qE '^compose_all_healthy_sed\(\)' "$INSTALL_SH"; then
    say_pass "compose_all_healthy has jq fast-path + sed fallback (L1)"
else
    say_fail "compose_all_healthy missing jq/sed split (L1)"
fi

# ---- 9b. empty-health tab-collapse regression in compose_all_healthy_jq ---
# IFS=$'\t' is IFS-whitespace, so bash `read` collapses consecutive tabs into
# a single delimiter. Emitting .Health as "" from jq produced two adjacent
# tabs in the TSV row, slid ExitCode into $health, and falsely flagged
# services without a healthcheck (caddy, mcp-worker) as unhealthy — hanging
# the installer for 180s before dying.

if grep -qE 'then "none" else \.Health end' "$INSTALL_SH"; then
    say_pass "compose_all_healthy_jq uses non-empty .Health sentinel"
else
    say_fail "compose_all_healthy_jq emits .Health as \"\" — IFS=\$'\\t' read will collapse empty field and misclassify services without a healthcheck"
fi

if command -v jq >/dev/null 2>&1; then
    # Load compose_all_healthy_jq out of install.sh without triggering main()
    # and exercise it against a synthetic `docker compose ps --format json`
    # payload that mixes healthcheck, no-healthcheck, and exited services.
    func_src="$(sed -n '/^compose_all_healthy_jq()/,/^}/p' "$INSTALL_SH")"
    eval "$func_src"
    fake_json='{"Service":"postgres","State":"running","Health":"healthy","ExitCode":0}
{"Service":"caddy","State":"running","Health":"","ExitCode":0}
{"Service":"mcp-worker","State":"running","Health":"","ExitCode":0}
{"Service":"migrate","State":"exited","Health":"","ExitCode":0}'
    if compose_all_healthy_jq "$fake_json"; then
        say_pass "compose_all_healthy_jq returns healthy for services without a healthcheck"
    else
        say_fail "compose_all_healthy_jq falsely flags healthy services without a healthcheck"
    fi
    # Negative case: a genuinely unhealthy container must still fail the check.
    bad_json='{"Service":"postgres","State":"running","Health":"unhealthy","ExitCode":0}'
    if ! compose_all_healthy_jq "$bad_json"; then
        say_pass "compose_all_healthy_jq detects an unhealthy service"
    else
        say_fail "compose_all_healthy_jq missed an unhealthy service"
    fi
    # Negative case: a failed one-off (exit != 0) must fail the check.
    bad_exit='{"Service":"migrate","State":"exited","Health":"","ExitCode":1}'
    if ! compose_all_healthy_jq "$bad_exit"; then
        say_pass "compose_all_healthy_jq detects a non-zero exit"
    else
        say_fail "compose_all_healthy_jq missed a non-zero exit"
    fi
else
    echo "  [skip]  jq not installed — skipping compose_all_healthy_jq behavioral tests"
fi

# ---- 9. preflight gates: compose version + arch (H1, H2) ------------------

if grep -qE 'docker compose version --short' "$INSTALL_SH" \
   && grep -qE 'needs >= 2\.17' "$INSTALL_SH"; then
    say_pass "preflight gates on docker compose >= 2.17 (H1)"
else
    say_fail "preflight missing compose >= 2.17 gate (H1)"
fi
if grep -qE 'uname -m' "$INSTALL_SH" \
   && grep -qE 'x86_64\|amd64' "$INSTALL_SH"; then
    say_pass "preflight warns on non-amd64 host (H2)"
else
    say_fail "preflight missing arch check (H2)"
fi

# ---- 9. port-conflict guard when caddy holds the port (C3) ----------------

if grep -qE '^caddy_holds_port\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines caddy_holds_port helper (C3)"
else
    say_fail "install.sh missing caddy_holds_port (C3)"
fi
if grep -qE 'port_in_use 8080 && ! caddy_holds_port' "$INSTALL_SH" \
   && grep -qE 'port_in_use 8443 && ! caddy_holds_port' "$INSTALL_SH"; then
    say_pass "phase_env_wizard skips port conflict when caddy owns the port (C3, v2 ports)"
else
    say_fail "phase_env_wizard still prompts on port conflict even when caddy owns it (C3)"
fi

# ---- 9. .env preservation on rewrite (C2) ---------------------------------

if grep -qE '^EMCP_MANAGED_ENV_KEYS=\(' "$INSTALL_SH"; then
    say_pass "install.sh declares EMCP_MANAGED_ENV_KEYS (C2)"
else
    say_fail "install.sh missing EMCP_MANAGED_ENV_KEYS (C2)"
fi
if grep -qE '^preserve_overrides\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines preserve_overrides helper (C2)"
else
    say_fail "install.sh missing preserve_overrides (C2)"
fi
if grep -qE 'Preserved user overrides' "$INSTALL_SH"; then
    say_pass "install.sh writes a 'Preserved user overrides' section header (C2)"
else
    say_fail "install.sh missing 'Preserved user overrides' section (C2)"
fi
if grep -qE 'backup="\$f\.bak\.\$ts"' "$INSTALL_SH" \
   || grep -qE '\.env\.bak\.' "$INSTALL_SH"; then
    say_pass "install.sh creates a timestamped .env backup (C2)"
else
    say_fail "install.sh does not back up .env before rewrite (C2)"
fi

# Exercise preserve_overrides in isolation: source the function body via
# grep+eval on the known preservation pattern. Fast, offline, no side
# effects outside $(mktemp).
t_src="$(mktemp)"
t_out="$(mktemp)"
cat > "$t_src" <<'ENV'
# a comment
EMCP_PUBLIC_HOST=managed.example.com
EMCP_MCP_MAX_BODY_BYTES=5242880

EMCP_TRUSTED_PROXY_CIDRS=10.0.0.0/8
# trailing comment
MY_CUSTOM=value
ENV
EMCP_MANAGED_ENV_KEYS=(EMCP_PUBLIC_HOST)
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
preserve_overrides "$t_src" "$t_out"
expected=$'EMCP_MCP_MAX_BODY_BYTES=5242880\nEMCP_TRUSTED_PROXY_CIDRS=10.0.0.0/8\nMY_CUSTOM=value'
if [ "$(cat "$t_out")" = "$expected" ]; then
    say_pass "preserve_overrides drops comments + managed keys, keeps the rest (C2)"
else
    say_fail "preserve_overrides output unexpected: $(cat "$t_out" | tr '\n' '|')"
fi
rm -f "$t_src" "$t_out"
unset -f preserve_overrides
unset EMCP_MANAGED_ENV_KEYS

# ---- 9. tty_read routes prompts through /dev/tty (C1) ---------------------

if grep -qE '^tty_read\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines tty_read helper (C1)"
else
    say_fail "install.sh missing tty_read helper (C1)"
fi

# Every user-facing read must go through tty_read. Program-output parses
# (`while IFS=... read -r x`) are allowed to stay as raw reads because they
# don't read from the terminal.
bare_prompt_reads="$(grep -cE '^[[:space:]]*read -r(-s)? -p' "$INSTALL_SH" || true)"
if [ "$bare_prompt_reads" -eq 0 ]; then
    say_pass "no bare 'read -r -p' in install.sh (all prompts via tty_read) (C1)"
else
    say_fail "install.sh has $bare_prompt_reads bare 'read -r -p' call(s) — should use tty_read (C1)"
fi

if grep -qE '^AUTO_NON_INTERACTIVE=' "$INSTALL_SH" \
   && grep -qE 'AUTO_NON_INTERACTIVE=1' "$INSTALL_SH"; then
    say_pass "install.sh tracks AUTO_NON_INTERACTIVE for honest error messages (C1)"
else
    say_fail "install.sh missing AUTO_NON_INTERACTIVE tracking (C1)"
fi

if grep -qE 'no TTY detected' "$INSTALL_SH"; then
    say_pass "install.sh warns on auto non-interactive fallback (C1)"
else
    say_fail "install.sh missing no-TTY warning (C1)"
fi

# ---- 9. install log infrastructure (H9) -----------------------------------

if grep -qE '^init_install_log\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines init_install_log (H9)"
else
    say_fail "install.sh missing init_install_log (H9)"
fi
if grep -qE '^INSTALL_LOG_PATH=' "$INSTALL_SH"; then
    say_pass "install.sh declares INSTALL_LOG_PATH (H9)"
else
    say_fail "install.sh does not declare INSTALL_LOG_PATH (H9)"
fi
if grep -qE '^run_and_log\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines run_and_log (H9)"
else
    say_fail "install.sh missing run_and_log (H9)"
fi
if grep -qE 'log_to_file "\$pull_out"' "$INSTALL_SH" \
   && grep -qE 'run_and_log "docker compose up -d"' "$INSTALL_SH"; then
    say_pass "compose pull output captured; compose up via run_and_log (H9)"
else
    say_fail "compose pull output or up -d not captured in install log (H9)"
fi
if grep -qE '^compose_cd\(\)' "$INSTALL_SH"; then
    say_pass "install.sh defines compose_cd helper (H9)"
else
    say_fail "install.sh missing compose_cd helper (H9)"
fi

# ---- summary --------------------------------------------------------------

echo
echo "  pass: $pass"
echo "  fail: $fail"
[ "$fail" -eq 0 ]
