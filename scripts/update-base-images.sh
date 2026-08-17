#!/usr/bin/env bash
# Refresh the digests and checksums the images are pinned to.
#
# Pinning by digest is only maintainable if refreshing it is one command. This
# script re-resolves every pin from its authoritative source and rewrites it in
# place; review the diff, then rebuild. It changes nothing else.
#
# Covers:
#   Dockerfile          — node base image digest
#   api/Dockerfile      — node base image digest
#   runner/Dockerfile   — python base image digest, Codex asset SHA256s,
#                         Node tarball SHA256s
#
# Requires: skopeo (or docker/podman with `manifest inspect`), curl, jq.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_IMAGE_REF="docker.io/library/node:22-alpine"
PYTHON_IMAGE_REF="docker.io/library/python:3.12-slim"

need() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing required tool: $1" >&2; exit 1; }
}
need curl
need jq
need skopeo

# The *index* digest, not a per-platform manifest digest: pinning a single
# platform's manifest would break the arm64 build outright.
index_digest() {
  local ref="$1" raw
  raw="$(skopeo inspect --raw "docker://${ref}")"
  printf 'sha256:%s' "$(printf '%s' "$raw" | sha256sum | cut -d' ' -f1)"
}

# Rewrite `ARG <name>=<image>@sha256:<old>` in place.
repin_image() {
  local file="$1" arg="$2" image="$3" digest="$4"
  local before after
  before="$(grep -c "^ARG ${arg}=" "$file" || true)"
  [ "$before" -eq 1 ] || { echo "$file: expected exactly one 'ARG ${arg}=', found ${before}" >&2; exit 1; }
  sed -i -E "s|^ARG ${arg}=.*$|ARG ${arg}=${image}@${digest}|" "$file"
  after="$(grep -c "^ARG ${arg}=${image}@${digest}$" "$file" || true)"
  [ "$after" -eq 1 ] || { echo "$file: rewriting ARG ${arg} failed" >&2; exit 1; }
  echo "  ${file}: ${arg}=${image}@${digest}"
}

repin_value() {
  local file="$1" arg="$2" value="$3"
  grep -qE "^ARG ${arg}=" "$file" || { echo "$file: no 'ARG ${arg}='" >&2; exit 1; }
  sed -i -E "s|^ARG ${arg}=.*$|ARG ${arg}=${value}|" "$file"
  echo "  ${file}: ${arg}=${value}"
}

arg_value() {
  sed -nE "s|^ARG $2=(.*)$|\1|p" "$1" | head -n1
}

echo "node base image:"
NODE_DIGEST="$(index_digest "$NODE_IMAGE_REF")"
repin_image Dockerfile NODE_IMAGE "node:22-alpine" "$NODE_DIGEST"
repin_image api/Dockerfile NODE_IMAGE "node:22-alpine" "$NODE_DIGEST"

echo "python base image:"
PYTHON_DIGEST="$(index_digest "$PYTHON_IMAGE_REF")"
repin_image runner/Dockerfile PYTHON_IMAGE "python:3.12-slim" "$PYTHON_DIGEST"

echo "runner Node tarballs:"
NODE_VERSION="$(arg_value runner/Dockerfile NODE_VERSION)"
SHASUMS="$(curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt")"
for pair in "AMD64:x64" "ARM64:arm64"; do
  suffix="${pair%%:*}"
  arch="${pair##*:}"
  sum="$(printf '%s\n' "$SHASUMS" | awk -v f="node-v${NODE_VERSION}-linux-${arch}.tar.xz" '$2==f {print $1}')"
  [ -n "$sum" ] || { echo "no SHASUM for node-v${NODE_VERSION}-linux-${arch}.tar.xz" >&2; exit 1; }
  repin_value runner/Dockerfile "NODE_SHA256_${suffix}" "$sum"
done

echo "runner Codex assets:"
CODEX_TAG="$(arg_value runner/Dockerfile CODEX_TAG)"
RELEASE="$(curl -fsSL "https://api.github.com/repos/openai/codex/releases/tags/${CODEX_TAG}")"
for pair in "AMD64:CODEX_ASSET_AMD64" "ARM64:CODEX_ASSET_ARM64"; do
  suffix="${pair%%:*}"
  asset="$(arg_value runner/Dockerfile "${pair##*:}")"
  digest="$(printf '%s' "$RELEASE" | jq -r --arg name "$asset" '.assets[] | select(.name==$name) | .digest // empty')"
  [ -n "$digest" ] || { echo "release ${CODEX_TAG} publishes no digest for ${asset}" >&2; exit 1; }
  repin_value runner/Dockerfile "CODEX_SHA256_${suffix}" "${digest#sha256:}"
done

echo
echo "Done. Review 'git diff' and rebuild both images before committing."
