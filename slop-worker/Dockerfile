FROM node:22-bookworm-slim AS build
WORKDIR /opt/slop
# Pinned slop-detector source (see vendor/VENDOR.md); only scan/report/rubric run here.
COPY vendor/slop-detector/package.json vendor/slop-detector/package-lock.json vendor/slop-detector/tsconfig.json ./
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY vendor/slop-detector/src ./src
RUN npx tsc && npm prune --omit=dev

FROM node:22-bookworm-slim
WORKDIR /opt/slop
COPY --from=build /opt/slop/node_modules ./node_modules
COPY --from=build /opt/slop/dist ./dist
COPY vendor/slop-detector/package.json vendor/slop-detector/0*.md ./
COPY worker.mjs /worker/worker.mjs
ENV DATA_ROOT=/app/storage SLOP_HOME=/opt/slop PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 HOME=/tmp
USER 10001:10001
CMD ["node", "/worker/worker.mjs"]
