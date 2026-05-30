# syntax=docker/dockerfile:1
# Production image: builds the client and bundles the server, then ships only
# the built artifacts (no sources, no node_modules). Used by docker-compose.yml.

# ---------- Build stage ----------
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable

# Install dependencies first (cached unless manifests/lockfile change).
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY server/package.json server/
COPY client/package.json client/
RUN pnpm install --frozen-lockfile

# Typecheck everything, then build client (Vite -> client/dist) and bundle the
# server into a single ESM file. The bundle inlines @buzzer/shared and the npm
# deps; the two optional native ws accelerators are left external (ws falls back
# gracefully without them).
COPY . .
RUN pnpm -r typecheck \
 && pnpm --filter @buzzer/client build \
 && pnpm --filter @buzzer/server exec esbuild src/index.ts \
      --bundle --platform=node --format=esm --target=node24 \
      --outfile=dist/index.js \
      --external:bufferutil --external:utf-8-validate \
      --banner:js="import{createRequire as __cr}from'module';const require=__cr(import.meta.url);"

# ---------- Runtime stage ----------
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    CLIENT_DIST=/app/client/dist

# Only the built artifacts ship — no node_modules, no sources.
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/client/dist ./client/dist

USER node
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
