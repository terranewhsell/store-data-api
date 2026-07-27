# Store Data API
#
# Two stages so the runtime image carries no build tooling and no dev
# dependencies. The result is small enough to deploy on a 512 MB free instance
# and to pull quickly on a cold start.
#
# The image runs the API only. Ingestion is a separate command (see
# `docker run ... bun run ingest`), because a free-tier web instance will be put
# to sleep mid-run and because a deploy should never start hitting the stores by
# surprise.

# ---------- dependencies ----------
FROM oven/bun:1.3-alpine AS deps
WORKDIR /app

# Only the manifests, so this layer is cached until the dependencies change.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# ---------- runtime ----------
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# Needed by the container healthcheck below.
RUN apk add --no-cache curl

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY src ./src
# The migrations are applied at boot, so they have to travel with the image.
COPY drizzle ./drizzle

# The base image ships a non-root `bun` user. Running as root inside a container
# that talks to the public internet buys nothing.
USER bun

EXPOSE 3000

# Fails the container rather than serving a process that is up but not answering.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:${PORT}/health || exit 1

CMD ["bun", "src/index.ts"]
