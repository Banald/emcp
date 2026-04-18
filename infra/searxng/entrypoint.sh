#!/bin/sh
# ---------------------------------------------------------------------------
# SearXNG wrapper entrypoint for the Echo compose stack.
#
# Renders the templated /etc/searxng/settings.template.yml into the real
# /etc/searxng/settings.yml SearXNG reads at boot. Only one transformation
# is done here: expanding the SEARXNG_OUTGOING_PROXIES env var into an
# `outgoing.proxies.all://` block (or stripping the marker when unset).
# The upstream SearXNG entrypoint still handles SEARXNG_SECRET substitution
# afterwards, so its semantics are unchanged.
#
# Mounted at:   /usr/local/bin/echo-searxng-entrypoint.sh (read-only)
# Launched via: compose.yaml `entrypoint:` override on the searxng service.
# ---------------------------------------------------------------------------
set -eu

TEMPLATE="/etc/searxng/settings.template.yml"
TARGET="/etc/searxng/settings.yml"
MARKER='# SEARXNG_OUTGOING_PROXIES_MARKER'

if [ ! -r "$TEMPLATE" ]; then
    echo "[echo-searxng] template $TEMPLATE not found — container misconfigured" >&2
    exit 1
fi

# Build the YAML block to inject — or leave empty to strip the marker.
BLOCK=""
if [ -n "${SEARXNG_OUTGOING_PROXIES:-}" ]; then
    # Start the block with outgoing.proxies.all://.
    BLOCK="outgoing:"
    BLOCK="$BLOCK
  request_timeout: 5.0
  proxies:
    all://:"
    # Split SEARXNG_OUTGOING_PROXIES on commas. Use `set --` with IFS so
    # shell-quoting of the URLs is irrelevant — each becomes one list
    # item in the generated YAML.
    OLD_IFS="$IFS"
    IFS=','
    # shellcheck disable=SC2086
    set -- $SEARXNG_OUTGOING_PROXIES
    IFS="$OLD_IFS"
    for raw in "$@"; do
        # Trim leading/trailing whitespace.
        url=$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
        [ -z "$url" ] && continue
        BLOCK="$BLOCK
      - \"$url\""
    done
fi

# Replace the marker line with $BLOCK (or strip it when $BLOCK is
# empty). awk is safer than sed here because URLs may contain /, :, @,
# and &, which would require heavy escaping with sed.
awk -v block="$BLOCK" -v marker="$MARKER" '
    $0 == marker {
        if (block != "") print block
        next
    }
    { print }
' "$TEMPLATE" > "$TARGET"

# Show a one-line confirmation at boot. Raw URLs are included — the
# compose env layer owns the credentials already, and SearXNG itself
# prints them in its own config dump, so adding redaction here would be
# a half-measure. The MCP server logs the redacted form separately.
if [ -n "${SEARXNG_OUTGOING_PROXIES:-}" ]; then
    # Hostnames only for this log line so credentials don't land in the
    # compose `logs` output.
    hosts=$(printf '%s' "$SEARXNG_OUTGOING_PROXIES" | awk -v RS=',' '{
        gsub(/^[[:space:]]*|[[:space:]]*$/, "", $0)
        if ($0 == "") next
        gsub(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^@\/]*@/, "")
        gsub(/\/.*/, "")
        if (NR > 1) printf ","
        printf "%s", $0
    }')
    echo "[echo-searxng] proxies enabled: $hosts" >&2
else
    echo "[echo-searxng] proxies disabled (direct egress)" >&2
fi

# Chain to the upstream SearXNG entrypoint, which handles SEARXNG_SECRET
# substitution, signal forwarding, and exec-ing the uwsgi server.
exec /usr/local/searxng/dockerfiles/docker-entrypoint.sh "$@"
