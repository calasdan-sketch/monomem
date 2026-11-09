# The base image is pinned to an exact version AND its digest (checked against Docker Hub), so a rebuild
# cannot silently pick up a different image. To update: pick a newer 24.x-alpine tag and its digest together.
# Build stage: compile TypeScript -> dist/
FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage: prod deps only, no toolchain
FROM node:24.22.2-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY SKILL.md INSTALL.md INFRA.md SECURITY.md README.md LICENSE ./

# Notes live on a mounted volume so they survive container restarts.
ENV MONOMEM_HOME=/data
ENV MONOMEM_DB_PATH=/data/state.db
# The node:alpine image ships an unprivileged `node` user; give it the data dir
# and run as it rather than root (defence in depth).
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]
USER node

# 8790 = HTTP API + dashboard, 8791 = MCP over HTTP (for the tunnel).
EXPOSE 8790 8791

# Readiness probe hits /ready on the API (which actually touches the DB) AND /health on the MCP port, so a
# half-dead container (one door down) is reported as unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=60s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8790/ready >/dev/null && wget -qO- http://127.0.0.1:8791/health >/dev/null || exit 1

CMD ["node", "dist/src/cli.js", "start"]
