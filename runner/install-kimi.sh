#!/bin/sh
# Install the pinned official bare binary only after manifest SHA-256 verification.
set -eu
arch=${1:-amd64}
version=${KIMI_VERSION:-2.5.3}
destination=${KIMI_INSTALL_PATH:-/usr/local/bin/kimi}
case "$arch" in
  amd64|x86_64) platform=linux-x64 ;;
  arm64|aarch64) platform=linux-arm64 ;;
  *) echo "Unsupported Kimi architecture: $arch" >&2; exit 1 ;;
esac
case "$version" in
  *[!0-9.]*|'') echo 'Invalid Kimi version' >&2; exit 1 ;;
esac
base="https://code.kimi.com/kimi-code/binaries/$version"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
curl -fsSL "$base/manifest.json" -o "$work/manifest.json"
filename=$(jq -er --arg platform "$platform" '.platforms[$platform].filename | select(type == "string")' "$work/manifest.json")
checksum=$(jq -er --arg platform "$platform" '.platforms[$platform].checksum | select(type == "string")' "$work/manifest.json")
case "$filename" in
  ''|*[!A-Za-z0-9._-]*|.|..) echo 'Invalid Kimi manifest filename' >&2; exit 1 ;;
esac
if ! printf '%s' "$checksum" | grep -Eq '^[a-fA-F0-9]{64}$'; then
  echo 'Invalid Kimi manifest checksum' >&2; exit 1
fi
curl -fsSL "$base/$filename" -o "$work/kimi"
printf '%s  %s\n' "$checksum" "$work/kimi" | sha256sum -c -
chmod 755 "$work/kimi"
# No operator home, update machinery or telemetry during the version assertion.
mkdir "$work/home"
installed=$(HOME="$work/home" KIMI_CODE_HOME="$work/home" KIMI_DISABLE_TELEMETRY=1 KIMI_CODE_NO_AUTO_UPDATE=1 "$work/kimi" --version)
if [ "$installed" != "$version" ] && [ "$installed" != "kimi $version" ]; then
  echo "Kimi version mismatch: expected $version" >&2; exit 1
fi
install -m 755 "$work/kimi" "$destination"
