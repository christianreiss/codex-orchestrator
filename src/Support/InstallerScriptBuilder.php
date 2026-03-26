<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Support;

use InvalidArgumentException;

final class InstallerScriptBuilder
{
    /**
     * @param array<string, mixed> $host
     * @param array<string, mixed> $tokenRow
     * @param array<string, mixed> $versions
     */
    public static function build(array $host, array $tokenRow, string $baseUrl, array $versions): string
    {
        $base = rtrim($baseUrl, '/');
        $apiKeyRaw = (string) ($tokenRow['api_key'] ?? ($host['api_key'] ?? ''));
        $fqdnRaw = (string) (($tokenRow['fqdn'] ?? '') !== '' ? $tokenRow['fqdn'] : ($host['fqdn'] ?? ''));

        if ($apiKeyRaw === '' || $fqdnRaw === '' || $base === '' || $base === 'http://' || $base === 'https://') {
            throw new InvalidArgumentException('Installer metadata missing (fqdn/base/api key)');
        }

        $clientVersion = is_string($versions['client_version'] ?? null) ? $versions['client_version'] : null;
        $codexVersion = CodexVersionPolicy::resolveEffective($clientVersion, false)['version'];

        $curlInsecure = self::resolveCurlInsecureFlag($host, $tokenRow) ? '1' : '0';

        $template = <<<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
BASE_URL='__BASE__'
API_KEY='__API__'
FQDN='__FQDN__'
CODEX_VERSION='__CODEX__'

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

DEFAULT_CURL_INSECURE='__CURL_INSECURE__'
CURL_INSECURE="${CODEX_INSTALL_CURL_INSECURE:-$DEFAULT_CURL_INSECURE}"

CURL_FLAGS=()
case "$CURL_INSECURE" in
  1|true|TRUE|True|t|T|yes|YES|Yes|y|Y)
    CURL_FLAGS+=('-k')
    ;;
esac

curl_fetch() {
  curl "${CURL_FLAGS[@]+"${CURL_FLAGS[@]}"}" "$@"
}

install_binary() {
  local src="$1"
  local dest="$2"
  if install -m 755 "$src" "$dest" 2>/dev/null; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1; then
    if sudo -n install -m 755 "$src" "$dest" 2>/dev/null; then
      return 0
    fi
  fi
  return 1
}

echo "Installing Codex for __FQDN__ via __BASE__"
if command -v codex >/dev/null 2>&1; then
  current_codex_path="$(command -v codex)"
  current_codex_version="$("$current_codex_path" -V 2>/dev/null | head -n1 || true)"
  if [ -n "$current_codex_version" ]; then
    echo "Current Codex: ${current_codex_version} (${current_codex_path})"
  else
    echo "Current Codex: installed (${current_codex_path})"
  fi
fi

echo "Target Codex: ${CODEX_VERSION}"

curl_fetch -fsSL "__BASE__/wrapper/download" -H "X-API-Key: __API__" -o "$tmpdir/cdx"
chmod +x "$tmpdir/cdx"
user_bin=0
install_path="/usr/local/bin/cdx"
if ! install_binary "$tmpdir/cdx" "$install_path"; then
  install_path="$HOME/.local/bin/cdx"
  mkdir -p "$(dirname "$install_path")"
  install -m 755 "$tmpdir/cdx" "$install_path"
  user_bin=1
fi

os="$(uname -s)"
arch="$(uname -m)"
version_lt() {
  local a="$1" b="$2"
  local a_major a_minor b_major b_minor
  a_major="${a%%.*}"
  a_minor="${a#*.}"
  a_minor="${a_minor%%.*}"
  b_major="${b%%.*}"
  b_minor="${b#*.}"
  b_minor="${b_minor%%.*}"
  if [[ ! "$a_major" =~ ^[0-9]+$ || ! "$a_minor" =~ ^[0-9]+$ || ! "$b_major" =~ ^[0-9]+$ || ! "$b_minor" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if (( a_major < b_major )); then
    return 0
  fi
  if (( a_major > b_major )); then
    return 1
  fi
  (( a_minor < b_minor ))
}

detect_glibc_version() {
  local out v
  if command -v getconf >/dev/null 2>&1; then
    out="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    v="${out#glibc }"
    if [[ "$v" =~ ^[0-9]+\\.[0-9]+ ]]; then
      printf '%s' "$v"
      return 0
    fi
  fi
  if command -v ldd >/dev/null 2>&1; then
    out="$(ldd --version 2>/dev/null | head -n1 || true)"
    if [[ "$out" == *"GNU libc"* ]]; then
      v="${out##* }"
      if [[ "$v" =~ ^[0-9]+\\.[0-9]+ ]]; then
        printf '%s' "$v"
        return 0
      fi
    fi
  fi
  printf ''
}

case "$os" in
  Linux)
    glibc_version="$(detect_glibc_version)"
    case "$arch" in
      x86_64|amd64)
        asset="codex-x86_64-unknown-linux-gnu.tar.gz"
        if [[ -z "$glibc_version" ]] || version_lt "$glibc_version" "2.39"; then
          asset="codex-x86_64-unknown-linux-musl.tar.gz"
        fi
        ;;
      aarch64|arm64)
        asset="codex-aarch64-unknown-linux-gnu.tar.gz"
        if [[ -z "$glibc_version" ]] || version_lt "$glibc_version" "2.39"; then
          asset="codex-aarch64-unknown-linux-musl.tar.gz"
        fi
        ;;
      *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  Darwin)
    case "$arch" in
      x86_64|amd64)
        asset="codex-x86_64-apple-darwin.tar.gz"
        ;;
      aarch64|arm64)
        asset="codex-aarch64-apple-darwin.tar.gz"
        ;;
      *) echo "Unsupported macOS arch: $arch" >&2; exit 1 ;;
    esac
    ;;
  *) echo "Unsupported OS: $os" >&2; exit 1 ;;
esac

curl_fetch -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}" -o "$tmpdir/codex.tar.gz"
tar -xzf "$tmpdir/codex.tar.gz" -C "$tmpdir"
codex_bin="$(find "$tmpdir" -type f ! -name "*.tar.gz" \( -name "codex" -o -name "codex-*" \) | head -n1)"
if [ -z "$codex_bin" ]; then
  echo "Codex binary not found in archive" >&2
  exit 1
fi

codex_path="/usr/local/bin/codex"
if ! install_binary "$codex_bin" "$codex_path"; then
  codex_path="$HOME/.local/bin/codex"
  mkdir -p "$(dirname "$codex_path")"
  install -m 755 "$codex_bin" "$codex_path"
  user_bin=1
fi

mkdir -p "$HOME/.codex"
"$install_path" --wrapper-version
if ! "$codex_path" -V; then
  echo "Codex install failed: ${codex_path} did not run cleanly." >&2
  exit 1
fi
if (( user_bin )); then
  echo "Note: ${HOME}/.local/bin is not on PATH by default. Add it if 'cdx' is not found."
fi
echo "Install complete for __FQDN__"
echo "Next steps:"
echo "  1) Check versions: cdx --version"
echo "  2) Sync auth + start Codex: cdx"
echo "  3) Run one-shot prompt: cdx --execute \"summarize this repo\""
SCRIPT;

        return strtr($template, [
            '__BASE__' => self::escapeForSingleQuotes($base),
            '__API__' => self::escapeForSingleQuotes($apiKeyRaw),
            '__FQDN__' => self::escapeForSingleQuotes($fqdnRaw),
            '__CODEX__' => self::escapeForSingleQuotes((string) $codexVersion),
            '__CURL_INSECURE__' => $curlInsecure,
        ]);
    }

    /**
     * @param array<string, mixed> $host
     * @param array<string, mixed> $tokenRow
     */
    private static function resolveCurlInsecureFlag(array $host, array $tokenRow): bool
    {
        foreach ([$tokenRow, $host] as $source) {
            if (!is_array($source)) {
                continue;
            }
            if (!array_key_exists('curl_insecure', $source)) {
                continue;
            }
            $normalized = self::normalizeBoolean($source['curl_insecure']);
            if ($normalized !== null) {
                return $normalized;
            }
        }

        return false;
    }

    private static function escapeForSingleQuotes(string $value): string
    {
        return str_replace("'", "'\\''", $value);
    }

    private static function normalizeBoolean(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            if (in_array($normalized, ['1', 'true', 't', 'yes', 'y'], true)) {
                return true;
            }
            if (in_array($normalized, ['0', 'false', 'f', 'no', 'n'], true)) {
                return false;
            }
        }

        return null;
    }
}
