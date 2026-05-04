#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# scripts/build-python-sandbox.sh — build the python-sandbox:latest image
# used by the `python-execute` MCP tool.
#
# Default builder is podman (matches the runtime the tool drives at request
# time); set EMCP_PYTHON_SANDBOX_RUNTIME=docker to use docker instead.
# Override the image tag with EMCP_PYTHON_SANDBOX_IMAGE.
#
# Run from anywhere — the script resolves its own location:
#     bash scripts/build-python-sandbox.sh
#     npm run sandbox:build
# ---------------------------------------------------------------------------

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE_DIR="$REPO_ROOT/infra/python-sandbox"

RUNTIME="${EMCP_PYTHON_SANDBOX_RUNTIME:-podman}"
IMAGE="${EMCP_PYTHON_SANDBOX_IMAGE:-python-sandbox:latest}"

if ! command -v "$RUNTIME" >/dev/null 2>&1; then
    printf '[fail] %s not on $PATH — install it or set EMCP_PYTHON_SANDBOX_RUNTIME\n' "$RUNTIME" >&2
    exit 1
fi
if [ ! -f "$DOCKERFILE_DIR/Dockerfile" ]; then
    printf '[fail] missing %s/Dockerfile\n' "$DOCKERFILE_DIR" >&2
    exit 1
fi

printf '[info] building %s using %s\n' "$IMAGE" "$RUNTIME" >&2
"$RUNTIME" build -t "$IMAGE" "$DOCKERFILE_DIR"

printf '[ok] built %s — sanity check:\n' "$IMAGE" >&2
"$RUNTIME" run --rm --network=none --read-only \
    --tmpfs /tmp:rw,exec,size=8m \
    --user 65534:65534 \
    "$IMAGE" \
    python3 -c 'import numpy, pandas, scipy, sympy, matplotlib, sklearn; print("ok")'
