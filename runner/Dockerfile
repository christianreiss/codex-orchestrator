# syntax=docker/dockerfile:1.7
# Auth-runner image: FastAPI plus all three engine CLIs.
#
# Every layer here fails closed. An image that builds without one of the three
# CLIs is worse than a build error — it boots, answers /health, and reports a
# multi-engine runner that silently cannot verify part of the fleet's credentials.
# Base pinned by multi-arch index digest; `scripts/update-base-images.sh`
# refreshes it, `runner/test_dockerfile_claims.py` holds the rules.
ARG PYTHON_IMAGE=python:3.12-slim@sha256:2c941e860699f878900b0edc2403613c234d4b32eda3cc9fa7036991a2a63c4a
FROM ${PYTHON_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq ca-certificates unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# --- Codex CLI (multi-arch, checksum-verified) ---
# Keep in step with the fleet's codex target: the probe must run the same
# model catalog as real hosts. 0.154.0 rejects gpt-6.1-sol with ChatGPT
# credentials while 0.162.1 serves it. Binary-only healthchecks cannot detect
# this provider/model incompatibility.
#
# The SHA256s are the release assets' published digests. A tag can be moved;
# a digest cannot, so the download is verified before anything is unpacked.
ARG CODEX_TAG=rust-v0.164.0
ARG CODEX_VERSION=0.164.0
ARG CODEX_ASSET_AMD64=codex-x86_64-unknown-linux-musl.tar.gz
ARG CODEX_ASSET_ARM64=codex-aarch64-unknown-linux-musl.tar.gz
ARG CODEX_SHA256_AMD64=90dd0b03b28afcb7fa733a4f73b413db2916a47347efd43fb669cc1c774ee8e4
ARG CODEX_SHA256_ARM64=29a507a2a3fd8f6cd94b96b762d281d299d15d7902dee6132d314b78cf9108eb
ARG TARGETARCH
RUN set -euo pipefail; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) asset="$CODEX_ASSET_AMD64"; sha="$CODEX_SHA256_AMD64" ;; \
      arm64) asset="$CODEX_ASSET_ARM64"; sha="$CODEX_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/openai/codex/releases/download/${CODEX_TAG}/${asset}"; \
    curl -fsSL "$url" -o /tmp/codex.tar.gz; \
    echo "${sha}  /tmp/codex.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/codex.tar.gz -C /usr/local/bin; \
    mv "/usr/local/bin/${asset%.tar.gz}" /usr/local/bin/codex; \
    chmod +x /usr/local/bin/codex; \
    rm -f /tmp/codex.tar.gz; \
    installed="$(codex --version)"; \
    case "$installed" in \
      *"$CODEX_VERSION"*) ;; \
      *) echo "codex reports '$installed', expected ${CODEX_VERSION}" >&2; exit 1 ;; \
    esac

# --- Node.js (checksum-verified against the release SHASUMS) ---
ARG NODE_VERSION=22.14.0
ARG NODE_SHA256_AMD64=69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec
ARG NODE_SHA256_ARM64=08bfbf538bad0e8cbb0269f0173cca28d705874a67a22f60b57d99dc99e30050
RUN set -euo pipefail; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) node_arch="x64"; sha="$NODE_SHA256_AMD64" ;; \
      arm64) node_arch="arm64"; sha="$NODE_SHA256_ARM64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${archive}" -o "/tmp/${archive}"; \
    echo "${sha}  /tmp/${archive}" | sha256sum -c -; \
    tar -xJf "/tmp/${archive}" --strip-components=1 -C /usr/local; \
    rm -f "/tmp/${archive}"; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    npm --version

# --- Claude Code CLI (exact latest-normal release, verified) ---
# Latest normal release as of 2026-10-26; vendor conservative stable is 2.1.308.
# No `|| true`. The previous form installed whatever npm served that minute and
# swallowed the failure, so a registry hiccup produced an image that claimed
# dual-engine readiness with no `claude` on PATH at all.
ARG CLAUDE_CODE_VERSION=2.1.310
RUN set -euo pipefail; \
    npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"; \
    command -v claude >/dev/null || { echo "claude not on PATH after install" >&2; exit 1; }; \
    installed="$(claude --version)"; \
    case "$installed" in \
      *"$CLAUDE_CODE_VERSION"*) ;; \
      *) echo "claude reports '$installed', expected ${CLAUDE_CODE_VERSION}" >&2; exit 1 ;; \
    esac; \
    npm cache clean --force

WORKDIR /app

# Official Grok native npm artifact, pinned by version AND sha512 integrity.
# Extract only package/bin/grok.br; Node's built-in Brotli avoids installers.
COPY install-grok.mjs /tmp/install-grok.mjs
ARG GROK_VERSION=1.0.70
RUN set -eu; GROK_VERSION="${GROK_VERSION}" node /tmp/install-grok.mjs "${TARGETARCH:-amd64}"; \
    grok --version | grep -F "grok ${GROK_VERSION} "; \
    rm /tmp/install-grok.mjs

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py entrypoint.sh /app/
COPY runner_engines.py grok.py images.py network_policy.py chatty.py exec_process.py /app/

RUN chmod +x /app/entrypoint.sh

# The versions the image was built with, so /health can report what it actually
# ships instead of re-shelling out to three CLIs on every probe.
ENV RUNNER_CODEX_VERSION=${CODEX_VERSION}
ENV RUNNER_CLAUDE_VERSION=${CLAUDE_CODE_VERSION}
ENV RUNNER_GROK_VERSION=${GROK_VERSION}
# All three engines are present by construction, so the runner must refuse to
# start if any binary went missing between build and boot.
ENV RUNNER_REQUIRED_ENGINES=codex,claude,grok
ENV PYTHONUNBUFFERED=1
ENV RUNNER_HOME_PARENT=/dev/shm
USER nobody
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
