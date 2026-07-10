FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq ca-certificates unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# --- Codex CLI (multi-arch) ---
# Keep in step with the fleet's codex target: the probe must run the same
# model catalog as real hosts. 0.125.0 predated the GPT-5.6 default probe
# model (gpt-5.6-terra) and rejected every VALID fresh login as
# "failed live verification", pinning the fleet canonical on a dead token.
ARG CODEX_TAG=rust-v0.144.1
ARG CODEX_ASSET_AMD64=codex-x86_64-unknown-linux-musl.tar.gz
ARG CODEX_ASSET_ARM64=codex-aarch64-unknown-linux-musl.tar.gz
ARG TARGETARCH
RUN set -euo pipefail; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) asset="$CODEX_ASSET_AMD64" ;; \
      arm64) asset="$CODEX_ASSET_ARM64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://github.com/openai/codex/releases/download/${CODEX_TAG}/${asset}"; \
    curl -fsSL "$url" -o /tmp/codex.tar.gz; \
    tar -xzf /tmp/codex.tar.gz -C /usr/local/bin; \
    mv "/usr/local/bin/${asset%.tar.gz}" /usr/local/bin/codex; \
    chmod +x /usr/local/bin/codex; \
    rm -f /tmp/codex.tar.gz

# --- Node.js + Claude Code CLI ---
ARG NODE_MAJOR=22
RUN set -euo pipefail; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) node_arch="x64" ;; \
      arm64) node_arch="arm64" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_MAJOR}.14.0/node-v${NODE_MAJOR}.14.0-linux-${node_arch}.tar.xz" \
      | tar -xJ --strip-components=1 -C /usr/local; \
    node --version && npm --version

RUN npm install -g @anthropic-ai/claude-code \
    && claude --version || true

WORKDIR /app

COPY requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py entrypoint.sh /app/

RUN chmod +x /app/entrypoint.sh

ENV PYTHONUNBUFFERED=1
ENV RUNNER_HOME_PARENT=/dev/shm
USER nobody
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
