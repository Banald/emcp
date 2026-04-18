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

version_line="$(grep -E '^ECHO_INSTALLER_VERSION=' "$INSTALL_SH" | head -n1 || true)"
if [ -n "$version_line" ] && [[ "$version_line" =~ ^ECHO_INSTALLER_VERSION=\"v[0-9]+\.[0-9]+\.[0-9]+.*\"$ ]]; then
    say_pass "ECHO_INSTALLER_VERSION has a valid stamp shape"
else
    say_fail "ECHO_INSTALLER_VERSION line missing or malformed (release.yml depends on exact prefix)"
fi

# ---- 5. help / usage doesn't explode -------------------------------------

if "$INSTALL_SH" --help >/dev/null 2>&1; then
    say_pass "install.sh --help returns 0"
else
    say_fail "install.sh --help returned non-zero"
fi

# emcp help without a compose install still runs (usage is help-text only).
if ECHO_HOME=/nonexistent EMCP_CONFIG_PATH=/nonexistent "$EMCP_BIN" help >/dev/null 2>&1; then
    say_pass "emcp help returns 0"
else
    say_fail "emcp help returned non-zero"
fi

# emcp with a missing compose file must fail, not silently pass.
tmp="$(mktemp -d)"
if ECHO_HOME="$tmp" EMCP_CONFIG_PATH=/nonexistent "$EMCP_BIN" status >/dev/null 2>&1; then
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

# ---- summary --------------------------------------------------------------

echo
echo "  pass: $pass"
echo "  fail: $fail"
[ "$fail" -eq 0 ]
