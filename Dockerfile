# syntax=docker/dockerfile:1.7
# Multi-stage build for the eMCP server.
# The same image runs either process — `mcp-server` or `mcp-worker` — chosen
# by the CMD override in compose.yaml.
#
# Base image is pinned by digest (OWASP Docker Cheat Sheet #13 — supply
# chain). Bump the digest by finding the current one:
#   docker buildx imagetools inspect node:24-bookworm-slim | grep Digest
# or let .github/dependabot.yml auto-PR a new digest weekly.

# --- deps: production node_modules only -----------------------------------
FROM node:24-bookworm-slim@sha256:879b21aec4a1ad820c27ccd565e7c7ed955f24b92e6694556154f251e4bdb240 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# --- build: compile TypeScript to dist/ -----------------------------------
FROM node:24-bookworm-slim@sha256:879b21aec4a1ad820c27ccd565e7c7ed955f24b92e6694556154f251e4bdb240 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# --- runtime: the final image --------------------------------------------
FROM node:24-bookworm-slim@sha256:879b21aec4a1ad820c27ccd565e7c7ed955f24b92e6694556154f251e4bdb240 AS runtime

ENV NODE_ENV=production \
    EMCP_BIND_HOST=0.0.0.0 \
    EMCP_PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 emcp \
    && useradd --system --uid 10001 --gid emcp --home-dir /app --shell /usr/sbin/nologin emcp

WORKDIR /app

COPY --from=deps --chown=emcp:emcp /app/node_modules ./node_modules
COPY --from=build --chown=emcp:emcp /app/dist ./dist
COPY --chown=emcp:emcp migrations ./migrations
COPY --chown=emcp:emcp package.json ./package.json
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER emcp
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
