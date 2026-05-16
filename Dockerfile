# syntax=docker/dockerfile:1.7
# Single-stage Node 22 image that builds the API and serves it directly.
# Replaces the previous PHP 8.2 / Apache image.

FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY api/package.json api/package-lock.json* ./api/
WORKDIR /app/api
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/api/node_modules ./api/node_modules
COPY api ./api
COPY public ./public
WORKDIR /app/api
RUN npm run typecheck && npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache tini libc6-compat curl
COPY --from=build /app/api/dist ./api/dist
COPY public ./public
WORKDIR /app/api/dist
RUN npm install --omit=dev --no-audit --no-fund
ENV STATIC_ROOT=/app/public/admin
ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
