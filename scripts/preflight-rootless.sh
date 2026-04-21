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
# scattering them through the output. Remediation strings may contain
# embedded newlines — main()'s render loop indents continuation lines so
# every line of a multi-step fix sits in the same column.
FAIL_LINES=()
record_fail() {
    local summary="$1" remediation="$2"
    log_err "$summary"
    FAIL_LINES+=("$summary"$'\t'"$remediation")
}

# --- Distro detection -----------------------------------------------------
# Echo one of: debian, fedora, arch, alpine, unknown.
#
# Matches both ID and ID_LIKE so derivatives (Rocky/Alma, Pop!_OS, Mint,
# Manjaro/EndeavourOS) pick the right family even when the bare ID isn't
# in the explicit list. Mirrors the dispatch table in install.sh's
# suggest_docker_install — keep them in sync if a new family lands.
_get_os_family() {
    local id="" id_like=""
    if [ -r /etc/os-release ]; then
        # shellcheck disable=SC1091
        id="$(. /etc/os-release >/dev/null 2>&1; printf '%s' "${ID:-}")"
        # shellcheck disable=SC1091
        id_like="$(. /etc/os-release >/dev/null 2>&1; printf '%s' "${ID_LIKE:-}")"
    fi
    case " $id $id_like " in
        *\ debian\ *|*\ ubuntu\ *|*\ linuxmint\ *|*\ pop\ *)        printf 'debian' ;;
        *\ fedora\ *|*\ rhel\ *|*\ centos\ *|*\ rocky\ *|*\ almalinux\ *) printf 'fedora' ;;
        *\ arch\ *|*\ manjaro\ *|*\ endeavouros\ *)                 printf 'arch' ;;
        *\ alpine\ *)                                                printf 'alpine' ;;
        *)                                                           printf 'unknown' ;;
    esac
}

# --- Multi-line remediation builder ---------------------------------------
# Accept one line per argument and produce a single string with each
# subsequent line indented by 4 spaces, so the rendered remediation block
# in main()'s report column-aligns under the first line.
#
#     fix="$(build_remediation \
#         "headline:" \
#         "  step one" \
#         "  step two")"
#
# Renders as:
#
#     - <summary>
#       headline:
#         step one
#         step two
build_remediation() {
    local first=1 line out=""
    for line in "$@"; do
        if [ "$first" -eq 1 ]; then
            out="$line"
            first=0
        else
            out+=$'\n    '"$line"
        fi
    done
    printf '%s' "$out"
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

    record_fail \
        "missing rootless deps: ${missing[*]}" \
        "$(remediation_packages)"
}

# Per-distro install commands for the rootless dependency trio. Names
# differ across families; we name every package each family needs so the
# operator can copy-paste a single command and not have to remember which
# distro renamed `dbus-user-session` to `dbus-daemon`.
remediation_packages() {
    case "$(_get_os_family)" in
        debian)
            build_remediation \
                "install on Debian / Ubuntu / Mint / Pop!_OS:" \
                "  sudo apt-get update" \
                "  sudo apt-get install -y uidmap slirp4netns dbus-user-session fuse-overlayfs" \
                "(uidmap supplies newuidmap/newgidmap; dbus-user-session is what makes 'systemctl --user' actually have a session bus to talk to.)" ;;
        fedora)
            build_remediation \
                "install on Fedora / RHEL / Rocky / Alma:" \
                "  sudo dnf install -y shadow-utils slirp4netns dbus-daemon fuse-overlayfs" \
                "(shadow-utils supplies newuidmap/newgidmap; dbus-daemon is the Fedora-equivalent of Debian's dbus-user-session.)" ;;
        arch)
            build_remediation \
                "install on Arch / Manjaro / EndeavourOS:" \
                "  sudo pacman -S --needed --noconfirm shadow slirp4netns dbus fuse-overlayfs" ;;
        alpine)
            build_remediation \
                "install on Alpine:" \
                "  sudo apk add shadow-uidmap slirp4netns fuse-overlayfs" \
                "(Alpine uses OpenRC by default — dbus-user-session is only needed on systemd hosts.)" ;;
        *)
            build_remediation \
                "install via your package manager:" \
                "  - 'uidmap' / shadow-utils  (provides newuidmap, newgidmap)" \
                "  - 'slirp4netns'            (rootless container networking)" \
                "  - 'dbus-user-session' / 'dbus-daemon'  (only on systemd hosts)" \
                "  - 'fuse-overlayfs'         (recommended; required if your kernel < 5.13)" ;;
    esac
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
        "$(build_remediation \
            "grant a subuid + subgid range of $min_range for $user. Pick whichever your shadow-utils supports:" \
            "  modern (Ubuntu 22.04+, Debian 12+, Fedora 35+, Arch, Alpine 3.18+):" \
            "    sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $user" \
            "  legacy fallback (if usermod errors with 'unrecognized option'):" \
            "    grep -q '^${user}:' /etc/subuid || echo '${user}:100000:65536' | sudo tee -a /etc/subuid" \
            "    grep -q '^${user}:' /etc/subgid || echo '${user}:100000:65536' | sudo tee -a /etc/subgid" \
            "after editing, log out and back in (or 'systemctl --user restart docker') so newuidmap re-reads the range.")"
}

check_apparmor_userns() {
    # Ubuntu 23.10+ ships with kernel.apparmor_restrict_unprivileged_userns=1,
    # which blocks rootlesskit from fork/exec'ing /proc/self/exe.
    # Symptom: `rootlesskit: failed to start the child: permission denied`.
    # Either install a per-binary AppArmor profile or flip the sysctl.
    local sysctl_path="/proc/sys/kernel/apparmor_restrict_unprivileged_userns"
    [ -r "$sysctl_path" ] || return 0  # kernel too old or AppArmor disabled — no issue
    local value
    value="$(cat "$sysctl_path" 2>/dev/null || echo 0)"
    if [ "$value" = "1" ]; then
        record_fail \
            "apparmor_restrict_unprivileged_userns=1 will block rootlesskit (Ubuntu 23.10+ / 24.04 default)" \
            "$(build_remediation \
                "two ways to fix; pick one:" \
                "  quick (disables a kernel hardening; OK on trusted single-tenant hosts):" \
                "    echo 'kernel.apparmor_restrict_unprivileged_userns=0' | sudo tee /etc/sysctl.d/60-rootless-docker.conf" \
                "    sudo sysctl --system" \
                "  correct (per-binary AppArmor profile, keeps the hardening on for everything else):" \
                "    follow https://rootlesscontaine.rs/getting-started/common/#apparmor (sample profile in docs/OPERATIONS.md → 'Ubuntu 23.10+ / 24.04')")"
        return
    fi
    log_ok "apparmor_restrict_unprivileged_userns not blocking rootlesskit"
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
            "$(remediation_install_rootless)"
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
            "$(remediation_socket_missing "$sock")"
        return
    fi

    # `docker info` emits a `rootless` SecurityOption when the daemon is
    # actually rootless. This is authoritative — distinguishes us from
    # the rootful /var/run/docker.sock even if DOCKER_HOST is unset.
    if ! info_sec_opts="$(docker info --format '{{range .SecurityOptions}}{{println .}}{{end}}' 2>/dev/null)"; then
        record_fail \
            "docker info failed against $sock" \
            "$(remediation_docker_info_failed "$sock")"
        return
    fi
    if ! printf '%s' "$info_sec_opts" | grep -q 'rootless'; then
        record_fail \
            "daemon at $sock is NOT rootless (missing 'rootless' SecurityOption)" \
            "$(remediation_not_rootless "$sock")"
        return
    fi
    log_ok "rootless Docker daemon reachable at $sock"
}

# `docker` not on $PATH: a brand-new host. Walk the operator through the
# full distro-specific install of rootless Docker, then enabling the user
# service, then exporting DOCKER_HOST.
remediation_install_rootless() {
    local sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock"
    case "$(_get_os_family)" in
        debian)
            build_remediation \
                "install rootless Docker on Debian / Ubuntu / Mint / Pop!_OS:" \
                "  # 1. dependencies (Debian's stock 'docker.io' package does NOT include rootless extras)" \
                "  sudo apt-get install -y uidmap slirp4netns dbus-user-session fuse-overlayfs curl ca-certificates" \
                "  # 2. install the rootless tarball into ~/bin and ~/.local/share/docker" \
                "  curl -fsSL https://get.docker.com/rootless | sh" \
                "  # 3. start the user-mode daemon (systemd unit lands in ~/.config/systemd/user/)" \
                "  systemctl --user enable --now docker" \
                "  # 4. tell every shell where to find it (add the export to ~/.bashrc to persist)" \
                "  export PATH=\$HOME/bin:\$PATH" \
                "  export DOCKER_HOST=unix://${sock}" \
                "if you already run docker-ce: 'sudo apt-get install -y docker-ce-rootless-extras' then 'dockerd-rootless-setuptool.sh install' replaces step 2." ;;
        fedora)
            build_remediation \
                "install rootless Docker on Fedora / RHEL / Rocky / Alma:" \
                "  # 1. dependencies" \
                "  sudo dnf install -y shadow-utils slirp4netns dbus-daemon fuse-overlayfs curl" \
                "  # 2. install the rootless tarball into ~/bin and ~/.local/share/docker" \
                "  curl -fsSL https://get.docker.com/rootless | sh" \
                "  # 3. start the user-mode daemon" \
                "  systemctl --user enable --now docker" \
                "  # 4. add to ~/.bashrc to persist" \
                "  export PATH=\$HOME/bin:\$PATH" \
                "  export DOCKER_HOST=unix://${sock}" \
                "if you already run docker-ce: 'sudo dnf install -y docker-ce-rootless-extras' then 'dockerd-rootless-setuptool.sh install' replaces step 2." ;;
        arch)
            build_remediation \
                "install rootless Docker on Arch / Manjaro:" \
                "  sudo pacman -S --needed --noconfirm docker shadow slirp4netns fuse-overlayfs" \
                "  dockerd-rootless-setuptool.sh install" \
                "  systemctl --user enable --now docker" \
                "  export DOCKER_HOST=unix://${sock}     # add to ~/.bashrc" ;;
        alpine)
            build_remediation \
                "install rootless Docker on Alpine (OpenRC):" \
                "  sudo apk add docker docker-cli shadow-uidmap slirp4netns fuse-overlayfs" \
                "  dockerd-rootless-setuptool.sh install" \
                "  rc-update add docker default && rc-service docker start" \
                "  export DOCKER_HOST=unix://${sock}     # add to ~/.profile" ;;
        *)
            build_remediation \
                "install rootless Docker (generic):" \
                "  # install uidmap, slirp4netns, dbus-user-session, fuse-overlayfs, curl via your package manager first." \
                "  curl -fsSL https://get.docker.com/rootless | sh" \
                "  systemctl --user enable --now docker     # systemd hosts only" \
                "  export DOCKER_HOST=unix://${sock}" ;;
    esac
}

# Socket missing: either rootless was never installed, or it's installed
# but the user-mode systemd unit isn't running. Detect which case to keep
# the remediation short — if the user systemd unit already exists we tell
# them to just start it; otherwise full bootstrap.
remediation_socket_missing() {
    local sock="$1"
    local user; user="$(id -un)"

    if [ -f "$HOME/.config/systemd/user/docker.service" ]; then
        build_remediation \
            "rootless Docker is installed but the user-mode daemon isn't running for $user. Start it:" \
            "  systemctl --user enable --now docker" \
            "  export DOCKER_HOST=unix://${sock}     # add to ~/.bashrc to persist across shells" \
            "if it fails to start, inspect the cause:" \
            "  systemctl --user status docker" \
            "  journalctl --user -u docker --since '10 min ago' --no-pager"
        return
    fi

    # No user systemd unit yet: full install is needed. Same content as
    # remediation_install_rootless but the headline calls out that the
    # CLI exists, only the daemon is missing — saves the operator from
    # thinking they need to reinstall the docker package.
    case "$(_get_os_family)" in
        debian)
            build_remediation \
                "the docker CLI is on \$PATH but no rootless daemon is set up for $user. Bootstrap on Debian / Ubuntu:" \
                "  # 1. dependencies (skip any you already have)" \
                "  sudo apt-get install -y uidmap slirp4netns dbus-user-session fuse-overlayfs" \
                "  # 2a. if you already use docker-ce: install rootless extras and run setuptool" \
                "  sudo apt-get install -y docker-ce-rootless-extras && dockerd-rootless-setuptool.sh install" \
                "  # 2b. otherwise, install the upstream rootless tarball into ~/bin" \
                "  #     curl -fsSL https://get.docker.com/rootless | sh" \
                "  # 3. start the user-mode daemon" \
                "  systemctl --user enable --now docker" \
                "  # 4. tell the docker CLI where to find it (persist in ~/.bashrc)" \
                "  export DOCKER_HOST=unix://${sock}" ;;
        fedora)
            build_remediation \
                "the docker CLI is on \$PATH but no rootless daemon is set up for $user. Bootstrap on Fedora / RHEL:" \
                "  # 1. dependencies (skip any you already have)" \
                "  sudo dnf install -y shadow-utils slirp4netns dbus-daemon fuse-overlayfs" \
                "  # 2a. if you already use docker-ce: install rootless extras and run setuptool" \
                "  sudo dnf install -y docker-ce-rootless-extras && dockerd-rootless-setuptool.sh install" \
                "  # 2b. otherwise, install the upstream rootless tarball into ~/bin" \
                "  #     curl -fsSL https://get.docker.com/rootless | sh" \
                "  # 3. start the user-mode daemon" \
                "  systemctl --user enable --now docker" \
                "  # 4. persist in ~/.bashrc" \
                "  export DOCKER_HOST=unix://${sock}" ;;
        arch)
            build_remediation \
                "no rootless daemon configured for $user. Set up on Arch / Manjaro:" \
                "  sudo pacman -S --needed --noconfirm shadow slirp4netns fuse-overlayfs" \
                "  dockerd-rootless-setuptool.sh install" \
                "  systemctl --user enable --now docker" \
                "  export DOCKER_HOST=unix://${sock}     # add to ~/.bashrc" ;;
        alpine)
            build_remediation \
                "no rootless daemon configured for $user. Set up on Alpine (OpenRC):" \
                "  sudo apk add shadow-uidmap slirp4netns fuse-overlayfs" \
                "  dockerd-rootless-setuptool.sh install" \
                "  rc-update add docker default && rc-service docker start" \
                "  export DOCKER_HOST=unix://${sock}     # add to ~/.profile" ;;
        *)
            build_remediation \
                "no rootless daemon configured for $user. Generic bootstrap:" \
                "  curl -fsSL https://get.docker.com/rootless | sh     # or: dockerd-rootless-setuptool.sh install (if rootless extras are already installed)" \
                "  systemctl --user enable --now docker                # systemd hosts only" \
                "  export DOCKER_HOST=unix://${sock}" ;;
    esac
}

# `docker info` failed: socket exists but the daemon is unreachable.
# Could be a stale socket from a crashed daemon, AppArmor (Ubuntu 23.10+)
# blocking rootlesskit's user-namespace fork, or DOCKER_HOST aimed at a
# misconfigured endpoint. Diagnostic-first remediation — tell the operator
# what to look at, not what to type blindly.
remediation_docker_info_failed() {
    local sock="$1"
    local user; user="$(id -un)"
    local group; group="$(id -gn)"
    build_remediation \
        "the socket at $sock exists but the daemon is unreachable. Diagnose in this order:" \
        "  # 1. is the user-mode daemon running?" \
        "  systemctl --user status docker" \
        "  # 2. what does the daemon say went wrong?" \
        "  journalctl --user -u docker --since '10 min ago' --no-pager" \
        "  # 3. is the socket owned by the current user?  (should be ${user}:${group})" \
        "  ls -l '$sock'" \
        "common causes:" \
        "  - stale socket from a crashed daemon → systemctl --user restart docker" \
        "  - Ubuntu 23.10+ AppArmor block → see the apparmor_restrict_unprivileged_userns check above" \
        "  - DOCKER_HOST points at a stale path → unset DOCKER_HOST and re-run, or set it to unix://${sock}"
}

# Daemon answered, but `docker info` reports it's NOT rootless. The
# operator is talking to /var/run/docker.sock (rootful) when they need
# the user-mode daemon. Install rootless alongside (the two coexist) and
# point DOCKER_HOST at the user socket.
remediation_not_rootless() {
    local sock="$1"
    local default_sock="/run/user/$(id -u)/docker.sock"
    local target_sock="$default_sock"
    [ -n "$sock" ] && [ "$sock" != "/var/run/docker.sock" ] && target_sock="$sock"
    case "$(_get_os_family)" in
        debian)
            build_remediation \
                "the daemon at $sock is rootful (you're talking to /var/run/docker.sock). Install rootless alongside on Debian / Ubuntu — the two coexist:" \
                "  sudo apt-get install -y uidmap slirp4netns dbus-user-session fuse-overlayfs" \
                "  sudo apt-get install -y docker-ce-rootless-extras && dockerd-rootless-setuptool.sh install" \
                "  # (no docker-ce repo? use 'curl -fsSL https://get.docker.com/rootless | sh' instead of the line above)" \
                "  systemctl --user enable --now docker" \
                "  export DOCKER_HOST=unix://${target_sock}     # add to ~/.bashrc" \
                "the rootful daemon can keep running; eMCP will only ever talk to the rootless one via DOCKER_HOST." ;;
        fedora)
            build_remediation \
                "the daemon at $sock is rootful (you're talking to /var/run/docker.sock). Install rootless alongside on Fedora / RHEL — the two coexist:" \
                "  sudo dnf install -y shadow-utils slirp4netns dbus-daemon fuse-overlayfs" \
                "  sudo dnf install -y docker-ce-rootless-extras && dockerd-rootless-setuptool.sh install" \
                "  # (no docker-ce repo? use 'curl -fsSL https://get.docker.com/rootless | sh' instead)" \
                "  systemctl --user enable --now docker" \
                "  export DOCKER_HOST=unix://${target_sock}     # add to ~/.bashrc" \
                "the rootful daemon can keep running; eMCP will only ever talk to the rootless one via DOCKER_HOST." ;;
        *)
            build_remediation \
                "the daemon at $sock is rootful. Install rootless alongside (the two coexist):" \
                "  curl -fsSL https://get.docker.com/rootless | sh" \
                "  systemctl --user enable --now docker" \
                "  export DOCKER_HOST=unix://${target_sock}     # add to ~/.bashrc" \
                "the rootful daemon can keep running; eMCP will only ever talk to the rootless one via DOCKER_HOST." ;;
    esac
}

# --- Driver ---------------------------------------------------------------

main() {
    log_step "Rootless Docker preflight"
    check_not_root
    check_platform
    check_kernel
    check_packages
    check_subid_ranges
    check_apparmor_userns
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
        # Single-line remediations stay bold (the call-to-action pops).
        # Multi-line blocks drop the bold attribute — bold across many
        # lines turns into visual noise on most terminals, and the
        # 4-space indent already separates the block from the summary.
        case "$remediation" in
            *$'\n'*)
                printf '  %s-%s %s\n    %s\n\n' "$C_RED" "$C_RESET" "$summary" "$remediation" >&2 ;;
            *)
                printf '  %s-%s %s\n    %s%s%s\n\n' "$C_RED" "$C_RESET" "$summary" "$C_BOLD" "$remediation" "$C_RESET" >&2 ;;
        esac
    done
    return 1
}

main "$@"
