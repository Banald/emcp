#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# preflight-rootless.sh — verify the host is ready to run eMCP rootless.
#
# Invoked by scripts/install.sh's phase_rootless_preflight, and usable
# standalone: `bash scripts/preflight-rootless.sh` prints the current
# state + any remediation commands the operator must run before the
# installer can proceed.
#
# Exit codes:
#   0  every precondition met
#   1  one or more preconditions missing; remediation block printed
#
# Design rules:
#   - Read-only. Never writes /etc, never runs sudo, never installs
#     packages. We only report.
#   - Every failure prints the EXACT command the operator should run.
#     "kernel too old" without a next step is useless.
#   - Overrides: set EMCP_SKIP_ROOTLESS_CHECK=1 to bypass for air-gapped
#     or unusual hosts. The installer itself still refuses to run as
#     root regardless; this bypass only lets the daemon checks pass.
# ---------------------------------------------------------------------------

set -euo pipefail

# --- Pretty-print helpers (stripped when not a TTY) -----------------------
if [ -t 2 ]; then
    C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
    C_RED=$'\033[1;31m'; C_YELLOW=$'\033[1;33m'
    C_GREEN=$'\033[1;32m'; C_CYAN=$'\033[1;36m'
else
    C_RESET=""; C_BOLD=""; C_RED=""; C_YELLOW=""; C_GREEN=""; C_CYAN=""
fi

log_ok()   { printf '%s[ok]%s     %s\n'   "$C_GREEN"  "$C_RESET" "$*" >&2; }
log_warn() { printf '%s[warn]%s   %s\n'   "$C_YELLOW" "$C_RESET" "$*" >&2; }
log_err()  { printf '%s[fail]%s   %s\n'   "$C_RED"    "$C_RESET" "$*" >&2; }
log_step() { printf '\n%s==>%s %s%s%s\n\n' "$C_CYAN"  "$C_RESET" "$C_BOLD" "$*" "$C_RESET" >&2; }

# --- Failure collector ----------------------------------------------------
# Each failed check appends one "summary<TAB>remediation" line so the
# final report groups remediation commands at the bottom rather than
# scattering them through the output.
FAIL_LINES=()
record_fail() {
    local summary="$1" remediation="$2"
    log_err "$summary"
    FAIL_LINES+=("$summary"$'\t'"$remediation")
}

# --- Individual checks ----------------------------------------------------

check_not_root() {
    # v2 refuses root even in the preflight. If the operator ran with
    # sudo they will hit /root/.local/share/emcp which is almost never
    # what they want.
    if [ "$(id -u)" -eq 0 ]; then
        record_fail \
            "running as root (uid 0)" \
            "rerun without sudo as the unprivileged user who will own the stack: bash scripts/preflight-rootless.sh"
        return
    fi
    log_ok "running as unprivileged user ($(id -un), uid=$(id -u))"
}

check_platform() {
    if [ "$(uname -s)" != "Linux" ]; then
        record_fail \
            "rootless Docker requires Linux (got $(uname -s))" \
            "(no remediation — use a Linux host)"
        return
    fi
    log_ok "Linux host"
}

check_kernel() {
    # Rootless overlay2 landed in 5.11; 5.13 added the reliable ID-mapped
    # mount support rootless benefits from. Anything below 5.13 silently
    # falls back to fuse-overlayfs (much slower). Warn is not a failure;
    # fuse-overlayfs still works.
    local kver major minor
    kver="$(uname -r 2>/dev/null || true)"
    if [ -z "$kver" ]; then
        log_warn "could not read kernel version (uname -r)"
        return
    fi
    major="${kver%%.*}"; minor="${kver#*.}"; minor="${minor%%.*}"
    if ! [[ "$major" =~ ^[0-9]+$ ]] || ! [[ "$minor" =~ ^[0-9]+$ ]]; then
        log_warn "kernel version unparseable: $kver"
        return
    fi
    if [ "$major" -lt 5 ] || { [ "$major" -eq 5 ] && [ "$minor" -lt 13 ]; }; then
        log_warn "kernel $kver is older than 5.13 — rootless Docker will use the slower fuse-overlayfs driver"
        return
    fi
    log_ok "kernel $kver supports native overlay2 for rootless"
}

check_packages() {
    # Rootless Docker's slirp4netns network + uidmap shadow-utils +
    # user-level dbus are the three package dependencies that matter.
    # Package names differ by distro; binaries are what we actually
    # probe, and the remediation string is tailored to the host's
    # /etc/os-release.
    local missing=()
    command -v newuidmap >/dev/null 2>&1 || missing+=("uidmap")
    command -v slirp4netns >/dev/null 2>&1 || missing+=("slirp4netns")
    # dbus-user-session ships /usr/lib/systemd/user/dbus.service. Skip
    # this probe on non-systemd hosts (Alpine/runit) — rootless docker
    # still works there, dbus-user-session is a systemd concern only.
    if command -v systemctl >/dev/null 2>&1 \
       && [ ! -f /usr/lib/systemd/user/dbus.service ] \
       && [ ! -f /usr/share/dbus-1/services ]; then
        missing+=("dbus-user-session")
    fi
    if [ ${#missing[@]} -eq 0 ]; then
        log_ok "rootless deps present: uidmap, slirp4netns, (dbus-user-session on systemd)"
        return
    fi

    # Per-distro remediation. Matches both ID and ID_LIKE so derivatives
    # (Rocky Linux, AlmaLinux, Pop!_OS, EndeavourOS, etc.) pick up the
    # right hint even when ID itself isn't in the list. Mirrors the
    # dispatch in install.sh's suggest_docker_install.
    local id="" id_like="" fix=""
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        id="$(. /etc/os-release >/dev/null 2>&1; printf '%s' "${ID:-}")"
        id_like="$(. /etc/os-release >/dev/null 2>&1; printf '%s' "${ID_LIKE:-}")"
    fi
    local haystack=" $id $id_like "
    case "$haystack" in
        *\ debian\ *|*\ ubuntu\ *|*\ linuxmint\ *|*\ pop\ *)
            fix="sudo apt install -y uidmap slirp4netns dbus-user-session" ;;
        *\ fedora\ *|*\ rhel\ *|*\ centos\ *|*\ rocky\ *|*\ almalinux\ *)
            fix="sudo dnf install -y shadow-utils slirp4netns dbus-daemon" ;;
        *\ arch\ *|*\ manjaro\ *|*\ endeavouros\ *)
            fix="sudo pacman -S --noconfirm shadow slirp4netns dbus" ;;
        *\ alpine\ *)
            fix="sudo apk add shadow-uidmap slirp4netns" ;;
        *)
            fix="install 'uidmap' (newuidmap/newgidmap), 'slirp4netns', and — on systemd hosts — 'dbus-user-session' via your package manager" ;;
    esac
    record_fail \
        "missing rootless deps: ${missing[*]}" \
        "$fix"
}

check_subid_ranges() {
    # Rootless Docker maps container UIDs into the operator's subuid
    # range. A range smaller than 65536 means uid 10001 inside the
    # container (USER emcp in our Dockerfile) may land outside — expect
    # `permission denied` on volume chowns.
    local user ok_uid=0 ok_gid=0 min_range=65536
    user="$(id -un)"
    if [ -r /etc/subuid ]; then
        local line count
        line="$(grep -E "^${user}:" /etc/subuid 2>/dev/null | head -n1 || true)"
        if [ -n "$line" ]; then
            count="${line##*:}"
            if [ "${count:-0}" -ge "$min_range" ] 2>/dev/null; then
                ok_uid=1
            fi
        fi
    fi
    if [ -r /etc/subgid ]; then
        local line count
        line="$(grep -E "^${user}:" /etc/subgid 2>/dev/null | head -n1 || true)"
        if [ -n "$line" ]; then
            count="${line##*:}"
            if [ "${count:-0}" -ge "$min_range" ] 2>/dev/null; then
                ok_gid=1
            fi
        fi
    fi
    if [ "$ok_uid" -eq 1 ] && [ "$ok_gid" -eq 1 ]; then
        log_ok "subuid + subgid ranges >= $min_range for $user"
        return
    fi
    record_fail \
        "$user has no subuid/subgid range (or range < $min_range) in /etc/sub{u,g}id" \
        "grant a subuid range: sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user"
}

check_linger() {
    # Without linger, the rootless daemon dies on logout. Mandatory for
    # any long-running deployment.
    if ! command -v loginctl >/dev/null 2>&1; then
        log_warn "loginctl not available; skipping linger check (non-systemd host?)"
        return
    fi
    local user linger
    user="$(id -un)"
    linger="$(loginctl show-user "$user" --property=Linger --value 2>/dev/null || true)"
    if [ "$linger" = "yes" ]; then
        log_ok "systemd linger enabled for $user (daemon survives logout)"
        return
    fi
    record_fail \
        "systemd linger is disabled for $user (rootless daemon will stop at logout)" \
        "enable linger: sudo loginctl enable-linger $user"
}

check_docker_daemon() {
    # We accept two daemon shapes: the user's systemd unit
    # (`systemctl --user is-active docker`) or a bare DOCKER_HOST
    # pointing at a user-owned socket (some operators use nerdctl /
    # Docker Desktop on Linux). Both are genuinely rootless.
    if [ "${EMCP_SKIP_ROOTLESS_CHECK:-0}" = "1" ]; then
        log_warn "EMCP_SKIP_ROOTLESS_CHECK=1 — skipping daemon-is-rootless verification"
        return
    fi

    if ! command -v docker >/dev/null 2>&1; then
        record_fail \
            "docker CLI not on \$PATH" \
            "install rootless Docker: curl -fsSL https://get.docker.com/rootless | sh"
        return
    fi

    # Prefer DOCKER_HOST if set and readable.
    local sock="" info_sec_opts=""
    if [ -n "${DOCKER_HOST:-}" ]; then
        case "$DOCKER_HOST" in
            unix://*) sock="${DOCKER_HOST#unix://}" ;;
        esac
    fi
    if [ -z "$sock" ]; then
        sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
    fi
    if [ ! -S "$sock" ]; then
        record_fail \
            "no user-owned docker socket at $sock" \
            "start rootless Docker: systemctl --user enable --now docker"
        return
    fi

    # `docker info` emits a `rootless` SecurityOption when the daemon is
    # actually rootless. This is authoritative — distinguishes us from
    # the rootful /var/run/docker.sock even if DOCKER_HOST is unset.
    if ! info_sec_opts="$(docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null)"; then
        record_fail \
            "docker info failed against $sock" \
            "verify daemon state: systemctl --user status docker"
        return
    fi
    if ! printf '%s' "$info_sec_opts" | grep -q 'rootless'; then
        record_fail \
            "daemon at $sock is NOT rootless (missing 'rootless' SecurityOption)" \
            "install rootless Docker (will coexist with rootful): curl -fsSL https://get.docker.com/rootless | sh; then export DOCKER_HOST=unix://\$XDG_RUNTIME_DIR/docker.sock"
        return
    fi
    log_ok "rootless Docker daemon reachable at $sock"
}

# --- Driver ---------------------------------------------------------------

main() {
    log_step "Rootless Docker preflight"
    check_not_root
    check_platform
    check_kernel
    check_packages
    check_subid_ranges
    check_linger
    check_docker_daemon

    if [ ${#FAIL_LINES[@]} -eq 0 ]; then
        log_step "All checks passed"
        return 0
    fi

    # Group remediation commands at the bottom so the operator can
    # copy-paste the full sequence.
    printf '\n%s==>%s %sRemediation (%d item%s)%s\n\n' \
        "$C_CYAN" "$C_RESET" "$C_BOLD" "${#FAIL_LINES[@]}" \
        "$([ ${#FAIL_LINES[@]} -eq 1 ] || printf 's')" "$C_RESET" >&2
    local line summary remediation
    for line in "${FAIL_LINES[@]}"; do
        summary="${line%%$'\t'*}"
        remediation="${line#*$'\t'}"
        printf '  %s-%s %s\n    %s%s%s\n\n' "$C_RED" "$C_RESET" "$summary" "$C_BOLD" "$remediation" "$C_RESET" >&2
    done
    return 1
}

main "$@"
