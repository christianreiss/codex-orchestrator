# syntax=docker/dockerfile:1.7
# API-only image: same build as the repository-root Dockerfile without the
# static admin console. Build from the repository root:
# docker build -f api/Dockerfile .
# Kept in step with it by
# `api/test/unit/ops/container-build-contract.test.ts`, which holds both files
# to the same rules — digest-pinned bases, `npm ci`, non-root runtime.
ARG NODE_IMAGE=node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

FROM ${NODE_IMAGE} AS build
ARG ORCHESTRATOR_BUILD_COMMIT
ARG ORCHESTRATOR_BUILD_DIRTY=true
WORKDIR /app/api
RUN apk add --no-cache python3 make g++ libc6-compat
COPY api/package.json api/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY api ./
COPY docs /app/docs
COPY public/admin/manual /app/public/admin/manual
COPY README.md /app/README.md
COPY wrappers/README.md /app/wrappers/README.md
COPY runner/README.md /app/runner/README.md
RUN npm run typecheck && ORCHESTRATOR_BUILD_COMMIT="$ORCHESTRATOR_BUILD_COMMIT" ORCHESTRATOR_BUILD_DIRTY="$ORCHESTRATOR_BUILD_DIRTY" npm run build

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app/runtime
RUN apk add --no-cache python3 make g++ libc6-compat
COPY --from=build /app/api/dist/package.json /app/api/dist/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
RUN apk add --no-cache tini libc6-compat util-linux \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S -G app -H -s /sbin/nologin app
WORKDIR /app/api/dist
COPY --from=build --chown=root:root /app/api/dist ./
COPY --from=prod-deps --chown=root:root /app/runtime/node_modules ./node_modules
RUN chmod -R a+rX /app/api/dist
ENV LISTEN_HOST=0.0.0.0
ENV LISTEN_PORT=8080
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
