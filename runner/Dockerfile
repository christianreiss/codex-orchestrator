FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl jq ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*

ARG CODEX_TAG=rust-v0.63.0
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

WORKDIR /app

COPY runner/requirements.txt requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

COPY runner/app.py runner/entrypoint.sh /app/
COPY bin/cdx /app/cdx

RUN chmod +x /app/entrypoint.sh /app/cdx

ENV PYTHONUNBUFFERED=1
EXPOSE 8080

ENTRYPOINT ["/app/entrypoint.sh"]
