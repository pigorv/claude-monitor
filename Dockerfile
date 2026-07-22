# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────
# Debian/glibc base: better-sqlite3@^12 ships a glibc prebuild for this Node ABI,
# so npm never falls back to node-gyp. Do NOT switch to Alpine/musl — there is no
# musl prebuild, so it would rebuild from source and fail without a C++ toolchain
# (this is issue #59). Keep a glibc base with a Node version that has a prebuild.
FROM node:22-bookworm-slim AS build
WORKDIR /app
# Install deps against a stable layer (better cache): copy manifests first.
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Production deps only — this reinstalls better-sqlite3 (native) using its glibc
# prebuild, so the runtime image needs no build toolchain.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Ship the built CLI + bundled SPA from the build stage.
# The CLI resolves the SPA relative to itself (dist/index.js + ./frontend), so
# dist/frontend/ must sit next to dist/index.js — this copies both together.
COPY --from=build /app/dist ./dist
# Bind beyond loopback so the published port (docker run -p ...) can reach the server.
# Callers still control host exposure via the -p mapping (e.g. -p 127.0.0.1:4173:4173).
ENV CLAUDE_MONITOR_HOST=0.0.0.0
EXPOSE 4173
# --no-open: no browser to launch in a container.
CMD ["node", "dist/index.js", "start", "--no-open"]
