# syntax=docker/dockerfile:1.7
# Multi-stage build for Echo MCP server.
# The same image runs either process — `mcp-server` or `mcp-worker` — chosen
# by the CMD override in compose.yaml.

# --- deps: production node_modules only -----------------------------------
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev --no-audit --no-fund

# --- build: compile TypeScript to dist/ -----------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# --- runtime: the final image --------------------------------------------
FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    BIND_HOST=0.0.0.0 \
    PORT=3000

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 echo \
    && useradd --system --uid 10001 --gid echo --home-dir /app --shell /usr/sbin/nologin echo

WORKDIR /app

COPY --from=deps --chown=echo:echo /app/node_modules ./node_modules
COPY --from=build --chown=echo:echo /app/dist ./dist
COPY --chown=echo:echo migrations ./migrations
COPY --chown=echo:echo package.json ./package.json
COPY --chown=root:root docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

USER echo
EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
