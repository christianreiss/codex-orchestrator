# syntax=docker/dockerfile:1.7
# Node 22 image that builds the API and serves it together with the static
# admin console under public/.
#
# Base images are pinned by multi-arch *index* digest, never by a floating tag:
# a tag is a moving target and two builds of the same commit must produce the
# same tree. `scripts/update-base-images.sh` refreshes the digests in one place,
# and `api/test/unit/ops/container-build-contract.test.ts` fails the suite if a
# FROM loses its pin, an install stops using `npm ci`, or the runtime stage
# forgets to drop root.
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

FROM ${NODE_IMAGE} AS build
WORKDIR /app/api
# Toolchain for any dependency without a prebuilt binding. It stays in this
# stage; the runtime image never gets a compiler.
RUN apk add --no-cache python3 make g++ libc6-compat
# Lockfile first so a source-only change reuses the install layer. `npm ci`
# fails outright when package-lock.json is missing or out of step with
# package.json — which is the point: an image must not silently re-resolve
# semver ranges into a tree nobody tested.
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api ./
RUN npm run typecheck && npm run build

# The build emits dist/package.json and dist/package-lock.json holding the exact
# closure of the specifiers esbuild left external. Installing from that pair is
# the whole production dependency tree — no dev packages, no re-resolution.
FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ libc6-compat
COPY --from=build /app/api/dist/package.json /app/api/dist/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
# tini reaps zombies under PID 1; libc6-compat backs the glibc-built native
# addons. Nothing else is installed — the healthcheck uses busybox wget.
RUN apk add --no-cache tini libc6-compat \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S -G app -H -s /sbin/nologin app
WORKDIR /app/api/dist
# Owned by root and readable by app: the process must never be able to rewrite
# its own code, and the compose service mounts the filesystem read-only anyway.
COPY --from=build --chown=root:root /app/api/dist ./
COPY --from=prod-deps --chown=root:root /app/node_modules ./node_modules
COPY --chown=root:root public /app/public
ENV STATIC_ROOT=/app/public/admin
ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=8080
# Fixed, unprivileged, and numeric so the value survives a base-image rebuild
# and so `DATA_ROOT` on the host can be chowned to something specific.
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
