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
        $mode = InstallerMode::normalize(is_string($tokenRow['engine'] ?? null) ? $tokenRow['engine'] : null);

        return match ($mode) {
            InstallerMode::CLAUDE => self::buildClaudeInstaller($base, $apiKeyRaw, $fqdnRaw, $curlInsecure),
            InstallerMode::BOTH => self::buildCombinedInstaller($base, $apiKeyRaw, $fqdnRaw, (string) $codexVersion, $curlInsecure),
            default => self::buildCodexInstaller($base, $apiKeyRaw, $fqdnRaw, (string) $codexVersion, $curlInsecure),
        };
    }

    private static function buildCodexInstaller(
        string $base,
        string $apiKeyRaw,
        string $fqdnRaw,
        string $codexVersion,
        string $curlInsecure
    ): string {
        $template = self::commonHeader() . self::codexFunctions() . <<<'SCRIPT'
echo "Installing Codex for ${FQDN} via ${BASE_URL}"
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

curl_fetch -fsSL "${BASE_URL}/wrapper/download?engine=codex" -H "X-API-Key: ${API_KEY}" -o "$tmpdir/cdx"
chmod +x "$tmpdir/cdx"
existing_cdx_path="$(command -v cdx 2>/dev/null || true)"
cdx_install_path="$(preferred_wrapper_path cdx "/usr/local/bin/cdx" "$HOME/.local/bin/cdx")"
if ! install_binary "$tmpdir/cdx" "$cdx_install_path"; then
  cdx_install_path="$HOME/.local/bin/cdx"
  mkdir -p "$(dirname "$cdx_install_path")"
  install -m 755 "$tmpdir/cdx" "$cdx_install_path"
  user_bin=1
fi

install_codex_cli "$tmpdir"

mkdir -p "$HOME/.codex"
"$cdx_install_path" --wrapper-version
if ! "$CODEX_BIN_PATH" -V; then
  echo "Codex install failed: ${CODEX_BIN_PATH} did not run cleanly." >&2
  exit 1
fi
print_shell_rehash_hint cdx "${existing_cdx_path:-}" "$cdx_install_path"
if (( user_bin )); then
  echo "Note: ${HOME}/.local/bin is not on PATH by default. Add it if 'cdx' is not found."
fi
echo "Install complete for ${FQDN}"
echo "Next steps:"
echo "  1) Check versions: cdx --version"
echo "  2) Sync auth + start Codex: cdx"
echo "  3) Run one-shot prompt: cdx --execute \"summarize this repo\""
SCRIPT;

        return self::renderTemplate($template, $base, $apiKeyRaw, $fqdnRaw, $curlInsecure, $codexVersion);
    }

    private static function buildClaudeInstaller(
        string $base,
        string $apiKeyRaw,
        string $fqdnRaw,
        string $curlInsecure
    ): string {
        $template = self::commonHeader() . self::claudeFunctions() . <<<'SCRIPT'
echo "Installing Claude Code for ${FQDN} via ${BASE_URL}"
current_claude_path="$(detect_claude_cli || true)"
if [ -n "$current_claude_path" ]; then
  current_claude_version="$("$current_claude_path" --version 2>/dev/null | head -n1 || true)"
  if [ -n "$current_claude_version" ]; then
    echo "Current Claude Code: ${current_claude_version} (${current_claude_path})"
  else
    echo "Current Claude Code: installed (${current_claude_path})"
  fi
fi

echo "Target Claude Code: latest npm release"

curl_fetch -fsSL "${BASE_URL}/wrapper/download?engine=claude" -H "X-API-Key: ${API_KEY}" -o "$tmpdir/clx"
chmod +x "$tmpdir/clx"
existing_clx_path="$(command -v clx 2>/dev/null || true)"
clx_install_path="$(preferred_wrapper_path clx "/usr/local/bin/clx" "$HOME/.local/bin/clx")"
if ! install_binary "$tmpdir/clx" "$clx_install_path"; then
  clx_install_path="$HOME/.local/bin/clx"
  mkdir -p "$(dirname "$clx_install_path")"
  install -m 755 "$tmpdir/clx" "$clx_install_path"
  user_bin=1
fi

install_claude_cli

mkdir -p "$HOME/.clx"
"$clx_install_path" --version
if ! "$CLAUDE_BIN_PATH" --version; then
  echo "Claude Code install failed: ${CLAUDE_BIN_PATH} did not run cleanly." >&2
  exit 1
fi
print_shell_rehash_hint clx "${existing_clx_path:-}" "$clx_install_path"
if (( user_bin )); then
  echo "Note: ${HOME}/.local/bin is not on PATH by default. Add it if 'clx' is not found."
fi
echo "Install complete for ${FQDN}"
echo "Next steps:"
echo "  1) Check versions: clx --version"
echo "  2) Sync auth + start Claude Code: clx"
echo "  3) Run one-shot prompt: clx \"summarize this repo\""
SCRIPT;

        return self::renderTemplate($template, $base, $apiKeyRaw, $fqdnRaw, $curlInsecure);
    }

    private static function buildCombinedInstaller(
        string $base,
        string $apiKeyRaw,
        string $fqdnRaw,
        string $codexVersion,
        string $curlInsecure
    ): string {
        $template = self::commonHeader() . self::codexFunctions() . self::claudeFunctions() . <<<'SCRIPT'
echo "Installing Codex + Claude for ${FQDN} via ${BASE_URL}"
if command -v codex >/dev/null 2>&1; then
  current_codex_path="$(command -v codex)"
  current_codex_version="$("$current_codex_path" -V 2>/dev/null | head -n1 || true)"
  if [ -n "$current_codex_version" ]; then
    echo "Current Codex: ${current_codex_version} (${current_codex_path})"
  fi
fi
current_claude_path="$(detect_claude_cli || true)"
if [ -n "$current_claude_path" ]; then
  current_claude_version="$("$current_claude_path" --version 2>/dev/null | head -n1 || true)"
  if [ -n "$current_claude_version" ]; then
    echo "Current Claude Code: ${current_claude_version} (${current_claude_path})"
  fi
fi

echo "Target Codex: ${CODEX_VERSION}"
echo "Target Claude Code: latest npm release"

curl_fetch -fsSL "${BASE_URL}/wrapper/download?engine=codex" -H "X-API-Key: ${API_KEY}" -o "$tmpdir/cdx"
chmod +x "$tmpdir/cdx"
existing_cdx_path="$(command -v cdx 2>/dev/null || true)"
cdx_install_path="$(preferred_wrapper_path cdx "/usr/local/bin/cdx" "$HOME/.local/bin/cdx")"
if ! install_binary "$tmpdir/cdx" "$cdx_install_path"; then
  cdx_install_path="$HOME/.local/bin/cdx"
  mkdir -p "$(dirname "$cdx_install_path")"
  install -m 755 "$tmpdir/cdx" "$cdx_install_path"
  user_bin=1
fi

curl_fetch -fsSL "${BASE_URL}/wrapper/download?engine=claude" -H "X-API-Key: ${API_KEY}" -o "$tmpdir/clx"
chmod +x "$tmpdir/clx"
existing_clx_path="$(command -v clx 2>/dev/null || true)"
clx_install_path="$(preferred_wrapper_path clx "/usr/local/bin/clx" "$HOME/.local/bin/clx")"
if ! install_binary "$tmpdir/clx" "$clx_install_path"; then
  clx_install_path="$HOME/.local/bin/clx"
  mkdir -p "$(dirname "$clx_install_path")"
  install -m 755 "$tmpdir/clx" "$clx_install_path"
  user_bin=1
fi

install_codex_cli "$tmpdir"
install_claude_cli

mkdir -p "$HOME/.codex" "$HOME/.clx"
"$cdx_install_path" --wrapper-version
"$clx_install_path" --version
if ! "$CODEX_BIN_PATH" -V; then
  echo "Codex install failed: ${CODEX_BIN_PATH} did not run cleanly." >&2
  exit 1
fi
if ! "$CLAUDE_BIN_PATH" --version; then
  echo "Claude Code install failed: ${CLAUDE_BIN_PATH} did not run cleanly." >&2
  exit 1
fi
print_shell_rehash_hint cdx "${existing_cdx_path:-}" "$cdx_install_path"
print_shell_rehash_hint clx "${existing_clx_path:-}" "$clx_install_path"
if (( user_bin )); then
  echo "Note: ${HOME}/.local/bin is not on PATH by default. Add it if 'cdx' or 'clx' is not found."
fi
echo "Install complete for ${FQDN}"
echo "Next steps:"
echo "  1) Check versions: cdx --version && clx --version"
echo "  2) Sync auth + start Codex: cdx"
echo "  3) Sync auth + start Claude Code: clx"
echo "  4) Run one-shot prompts: cdx --execute \"summarize this repo\" or clx \"summarize this repo\""
SCRIPT;

        return self::renderTemplate($template, $base, $apiKeyRaw, $fqdnRaw, $curlInsecure, $codexVersion);
    }

    private static function commonHeader(): string
    {
        return <<<'SCRIPT'
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

preferred_wrapper_path() {
  local name="$1"
  local system_path="$2"
  local user_path="$3"
  local current_path=""
  current_path="$(command -v "$name" 2>/dev/null || true)"
  case "$current_path" in
    "$system_path"|"$user_path")
      printf '%s' "$current_path"
      return 0
      ;;
  esac
  printf '%s' "$system_path"
}

print_shell_rehash_hint() {
  local name="$1"
  local previous_path="$2"
  local installed_path="$3"
  if [[ -n "$previous_path" && "$previous_path" != "$installed_path" ]]; then
    echo "Note: your current shell may still cache ${name} at ${previous_path}. Run 'hash -r' if '${name}' still shows the old wrapper."
  fi
}

user_bin=0

SCRIPT;
    }

    private static function codexFunctions(): string
    {
        return <<<'SCRIPT'
CODEX_BIN_PATH=""

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
    if [[ "$v" =~ ^[0-9]+\.[0-9]+ ]]; then
      printf '%s' "$v"
      return 0
    fi
  fi
  if command -v ldd >/dev/null 2>&1; then
    out="$(ldd --version 2>/dev/null | head -n1 || true)"
    if [[ "$out" == *"GNU libc"* ]]; then
      v="${out##* }"
      if [[ "$v" =~ ^[0-9]+\.[0-9]+ ]]; then
        printf '%s' "$v"
        return 0
      fi
    fi
  fi
  printf ''
}

install_codex_cli() {
  local workdir="$1"
  local os arch glibc_version asset codex_bin
  os="$(uname -s)"
  arch="$(uname -m)"

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
        x86_64|amd64) asset="codex-x86_64-apple-darwin.tar.gz" ;;
        aarch64|arm64) asset="codex-aarch64-apple-darwin.tar.gz" ;;
        *) echo "Unsupported macOS arch: $arch" >&2; exit 1 ;;
      esac
      ;;
    *) echo "Unsupported OS: $os" >&2; exit 1 ;;
  esac

  curl_fetch -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}" -o "$workdir/codex.tar.gz"
  tar -xzf "$workdir/codex.tar.gz" -C "$workdir"
  codex_bin="$(find "$workdir" -type f ! -name "*.tar.gz" \( -name "codex" -o -name "codex-*" \) | head -n1)"
  if [ -z "$codex_bin" ]; then
    echo "Codex binary not found in archive" >&2
    exit 1
  fi

  CODEX_BIN_PATH="/usr/local/bin/codex"
  if ! install_binary "$codex_bin" "$CODEX_BIN_PATH"; then
    CODEX_BIN_PATH="$HOME/.local/bin/codex"
    mkdir -p "$(dirname "$CODEX_BIN_PATH")"
    install -m 755 "$codex_bin" "$CODEX_BIN_PATH"
    user_bin=1
  fi
}

SCRIPT;
    }

    private static function claudeFunctions(): string
    {
        return <<<'SCRIPT'
CLAUDE_BIN_PATH=""

detect_claude_cli() {
  if command -v claude >/dev/null 2>&1; then
    command -v claude
    return 0
  fi
  if command -v claude-code >/dev/null 2>&1; then
    command -v claude-code
    return 0
  fi
  return 1
}

install_claude_cli() {
  local existing=""
  existing="$(detect_claude_cli || true)"
  if [ -n "$existing" ]; then
    CLAUDE_BIN_PATH="$existing"
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "Claude Code install requires npm (Node.js >= 18)." >&2
    exit 1
  fi

  if ! npm install -g @anthropic-ai/claude-code 2>/dev/null; then
    if [ "$(id -u)" != "0" ] && command -v sudo >/dev/null 2>&1; then
      sudo npm install -g @anthropic-ai/claude-code
    else
      echo "Claude Code npm install failed." >&2
      exit 1
    fi
  fi
  CLAUDE_BIN_PATH="$(detect_claude_cli || true)"
  if [ -z "$CLAUDE_BIN_PATH" ]; then
    echo "Claude Code CLI not found after npm install." >&2
    exit 1
  fi
}

SCRIPT;
    }

    private static function renderTemplate(
        string $template,
        string $base,
        string $apiKeyRaw,
        string $fqdnRaw,
        string $curlInsecure,
        string $codexVersion = ''
    ): string {
        return strtr($template, [
            '__BASE__' => self::escapeForSingleQuotes($base),
            '__API__' => self::escapeForSingleQuotes($apiKeyRaw),
            '__FQDN__' => self::escapeForSingleQuotes($fqdnRaw),
            '__CODEX__' => self::escapeForSingleQuotes($codexVersion),
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
