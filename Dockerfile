# The base image is pinned to an exact version AND its digest (checked against Docker Hub), so a rebuild
# cannot silently pick up a different image. To update: pick a newer 24.x-alpine tag and its digest together.
# Build stage: compile TypeScript -> dist/
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: prod deps only, no toolchain
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY SKILL.md INSTALL.md INFRA.md SECURITY.md README.md LICENSE ./
# `monomem check` replays the attack scenarios from here; without them the check reports Grade C in the image.
COPY bench/scenarios ./bench/scenarios

# Notes live on a mounted volume so they survive container restarts.
ENV MONOMEM_HOME=/data
ENV MONOMEM_DB_PATH=/data/state.db
# The node:alpine image ships an unprivileged `node` user; give it the data dir
# and run as it rather than root (defence in depth).
RUN mkdir -p /data && chown -R node:node /data
# `monomem` on PATH, so the guides' `docker compose exec monomem monomem token add ...` works as written.
RUN printf '#!/bin/sh\nexec node /app/dist/src/cli.js "$@"\n' > /usr/local/bin/monomem && chmod 755 /usr/local/bin/monomem
VOLUME ["/data"]
USER node

# 8790 = HTTP API + dashboard, 8791 = MCP over HTTP (for the tunnel).
EXPOSE 8790 8791

# Readiness probe hits /ready on the API (which actually touches the DB) AND /health on the MCP port, so a
# half-dead container (one door down) is reported as unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/ready >/dev/null && wget -qO- http://127.0.0.1:8791/health >/dev/null || exit 1

CMD ["node", "dist/src/cli.js", "start"]
