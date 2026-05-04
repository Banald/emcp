# syntax=docker/dockerfile:1.7
# python-sandbox:latest — the image the `python-execute` MCP tool runs every
# invocation against. Built locally via `bash scripts/build-python-sandbox.sh`
# (or `npm run sandbox:build`); never pushed to a registry, never wired into
# the eMCP compose stack.
#
# Runtime guarantees the image asserts (the rest are enforced by the
# `podman run` flags in src/shared/sandbox/python-runner.ts):
#   - Python 3.12 with the scientific stack pre-installed (numpy, pandas,
#     scipy, sympy, matplotlib, scikit-learn). No pip at runtime — the
#     container has --network=none, so pip would fail anyway.
#   - Final USER 65534:65534 (uid/gid `nobody`) so the read-only rootfs
#     plus dropped capabilities leave nothing to escalate.
#   - WORKDIR /tmp so the user's code lands in the writable tmpfs that the
#     runner mounts; the image's actual /tmp is shadowed by the tmpfs.

FROM python:3.12-slim

# Pre-install the scientific stack. --no-cache-dir keeps the image lean,
# and we wipe /root/.cache + temp paths afterwards so a stowaway pip cache
# can't inflate the image.
RUN pip install --no-cache-dir \
        numpy \
        pandas \
        scipy \
        sympy \
        matplotlib \
        scikit-learn \
 && rm -rf /root/.cache /tmp/* /var/tmp/*

WORKDIR /tmp
USER 65534:65534

# No CMD: the runner always passes `python3 -u -` on the `podman run`
# command line so the invocation reads code from stdin rather than from
# argv (defense in depth — code is never visible to `ps`).
