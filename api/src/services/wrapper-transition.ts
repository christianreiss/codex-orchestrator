import type { Engine } from '../util/engine.js';
import { ENGINE_CLAUDE } from '../util/engine.js';
import type { VersionSnapshot } from './version-snapshot.js';

export function isLegacyShellWrapperVersion(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const version = value.trim();
  return /^\d{4}\.\d{2}\.\d{2}(?:[-+][A-Za-z0-9._-]+)*$/.test(version);
}

export function legacyWrapperDownloadUrl(engine: Engine): string {
  return `/wrapper/download?engine=${engine}`;
}

export function withLegacyShellWrapperTransition(
  summary: VersionSnapshot,
  submittedWrapperVersion: unknown,
  engine: Engine,
): VersionSnapshot {
  if (!isLegacyShellWrapperVersion(submittedWrapperVersion)) return summary;
  return {
    ...summary,
    wrapper_sha256: null,
    wrapper_url: legacyWrapperDownloadUrl(engine),
  };
}

export function buildWrapperV2InstallerScript(opts: {
  fqdn: string;
  apiKey: string;
  baseUrl: string;
  engine: Engine;
  allowInsecure?: boolean;
  peerEngines?: Engine[];
}): string {
  if (!opts.apiKey) throw new Error('Installer host API key missing');
  if (!opts.fqdn) throw new Error('Installer host FQDN missing');

  const name = binaryName(opts.engine);
  const peers = (opts.peerEngines ?? []).filter((e) => e !== opts.engine);
  const requestedEngines = [...new Set<Engine>([opts.engine, ...peers])];
  const needsClaude = requestedEngines.includes(ENGINE_CLAUDE);
  const hasCodex = requestedEngines.some((engine) => engine !== ENGINE_CLAUDE);
  const installLabel = requestedEngines
    .map((engine) => (engine === ENGINE_CLAUDE ? 'Claude' : 'Codex'))
    .join(' + ');
  const peerBlock = peers.length > 0 ? peers.map(peerInstallBlock).join('\n') : undefined;
  const defaultCurlInsecure = opts.allowInsecure ? '1' : '0';

  return `#!/bin/sh
# Codex Orchestrator wrapper-v2 installer for ${name}.
# Generated for host ${commentValue(opts.fqdn)}.
set -eu

BASE_URL=${shellQuote(opts.baseUrl.replace(/\/+$/, ''))}
HOST_API_KEY=${shellQuote(opts.apiKey)}
ENGINE=${shellQuote(opts.engine)}
NAME=${shellQuote(name)}
CONFIG_FILE=${shellQuote(`${name}.json`)}
CONFIG_ENV=${shellQuote(opts.engine === ENGINE_CLAUDE ? 'CLX_CONFIG_PATH' : 'CDX_CONFIG_PATH')}
HOST_LABEL=${shellQuote(opts.fqdn)}
INSTALL_LABEL=${shellQuote(installLabel)}
NEEDS_CLAUDE=${needsClaude ? '1' : '0'}
HAS_CODEX=${hasCodex ? '1' : '0'}
HAS_CLAUDE=${needsClaude ? '1' : '0'}
INSTALL_CONTEXT=installer
CODEX_INSTALL_CURL_INSECURE=\${CODEX_INSTALL_CURL_INSECURE:-${defaultCurlInsecure}}

BIN_DIR=\${BIN_DIR:-/usr/local/bin}

# Pull signed host config(s), install the wrapper(s), then bootstrap each
# engine explicitly. The installer owns peer ordering, so cron peer-spawn is
# suppressed during this one run to avoid duplicate work and hidden failures.
${bootstrapBody({ peerBlock })}

INSTALL_FINISHED=1
ui_divider
if [ "$INSTALL_FAILED" = "0" ]; then
  ui_result_ok "READY" "$INSTALL_LABEL installed successfully"
  if [ "$HAS_CODEX" = "1" ]; then
    ui_hint "cdx run       Start Codex"
  fi
  if [ "$HAS_CLAUDE" = "1" ]; then
    ui_hint "clx run       Start Claude Code"
  fi
  if [ "$HAS_CODEX" = "1" ]; then
    ui_hint "cdx doctor    Verify Codex setup"
  fi
  if [ "$HAS_CLAUDE" = "1" ]; then
    ui_hint "clx doctor    Verify Claude setup"
  fi
  if [ "$BIN_ROOT_ON_PATH" = "0" ]; then
    ui_warn "setup" "PATH" "$BIN_ROOT" "not active in the parent shell"
    ui_path_hint
  fi
  exit 0
fi

ui_result_fail "INCOMPLETE" "One or more requested components failed"
if [ "$BIN_ROOT_ON_PATH" = "0" ]; then
  ui_warn "setup" "PATH" "$BIN_ROOT" "not active in the parent shell"
  ui_path_hint
fi
if [ "$HAS_CODEX" = "1" ]; then
  ui_hint "Retry Codex cron: cdx --minimal --cron install"
  ui_hint "Retry Codex CLI:  cdx --minimal --cron run"
fi
if [ "$HAS_CLAUDE" = "1" ]; then
  ui_hint "Retry Claude cron: clx --minimal --cron install"
  ui_hint "Retry Claude CLI:  clx --minimal --cron run"
fi
ui_hint "If wrapper/config installation failed, mint a fresh single-use installer."
exit 1
`;
}

export function buildLegacyWrapperTransitionScript(opts: {
  fqdn: string;
  apiKey: string;
  baseUrl: string;
  engine: Engine;
}): string {
  const name = binaryName(opts.engine);
  return `#!/bin/sh
# Codex Orchestrator legacy transition launcher for ${name}.
# Generated for host ${commentValue(opts.fqdn)}.
set -eu

BASE_URL=${shellQuote(opts.baseUrl.replace(/\/+$/, ''))}
HOST_API_KEY=${shellQuote(opts.apiKey)}
ENGINE=${shellQuote(opts.engine)}
NAME=${shellQuote(name)}
CONFIG_FILE=${shellQuote(`${name}.json`)}
CONFIG_ENV=${shellQuote(opts.engine === ENGINE_CLAUDE ? 'CLX_CONFIG_PATH' : 'CDX_CONFIG_PATH')}
INSTALL_CONTEXT=transition

${bootstrapBody()}
`;
}

function bootstrapBody(opts?: { peerBlock?: string }): string {
  const peerSection = opts?.peerBlock != null ? `\n${opts.peerBlock}` : '';
  return `PARENT_PATH=\${PATH:-}
if [ -z "$PARENT_PATH" ]; then
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi

INSTALL_FAILED=0
INSTALL_FINISHED=0
BUNDLE_FILE=
BIN_TMP=
STEP_LOG=
NODE_SHIM_TMP=
NPM_SHIM_TMP=

UI_TTY=0
UI_UTF8=0
if [ -t 1 ] && [ "\${TERM:-dumb}" != "dumb" ]; then
  UI_TTY=1
fi
case "\${LC_ALL:-\${LC_CTYPE:-\${LANG:-}}}" in
  *UTF-8*|*utf-8*|*UTF8*|*utf8*)
    if [ "$UI_TTY" = "1" ]; then UI_UTF8=1; fi
    ;;
esac

UI_RESET=
UI_BOLD=
UI_DIM=
UI_CYAN=
UI_GREEN=
UI_RED=
UI_YELLOW=
if [ "$UI_TTY" = "1" ] && [ -z "\${NO_COLOR:-}" ]; then
  UI_RESET=$(printf '\\033[0m')
  UI_BOLD=$(printf '\\033[1m')
  UI_DIM=$(printf '\\033[2m')
  UI_CYAN=$(printf '\\033[96m')
  UI_GREEN=$(printf '\\033[32m')
  UI_RED=$(printf '\\033[31m')
  UI_YELLOW=$(printf '\\033[33m')
fi

ui_line() {
  UI_MARK=$1
  UI_COLOR=$2
  UI_ENGINE=$3
  UI_COMPONENT=$4
  UI_VERSION=$5
  UI_STATUS=$6
  if [ "$UI_UTF8" = "1" ]; then
    if [ -n "$UI_VERSION" ]; then
      printf '%s%s%s · %s%s%s · %s%s%s · %s%s%s · %s%s%s\n' \\
        "$UI_COLOR" "$UI_MARK" "$UI_RESET" \\
        "$UI_BOLD" "$UI_ENGINE" "$UI_RESET" \\
        "$UI_DIM" "$UI_COMPONENT" "$UI_RESET" \\
        "$UI_BOLD" "$UI_VERSION" "$UI_RESET" \\
        "$UI_COLOR" "$UI_STATUS" "$UI_RESET"
    else
      printf '%s%s%s · %s%s%s · %s%s%s · %s%s%s\n' \\
        "$UI_COLOR" "$UI_MARK" "$UI_RESET" \\
        "$UI_BOLD" "$UI_ENGINE" "$UI_RESET" \\
        "$UI_DIM" "$UI_COMPONENT" "$UI_RESET" \\
        "$UI_COLOR" "$UI_STATUS" "$UI_RESET"
    fi
  elif [ -n "$UI_VERSION" ]; then
    printf '%s | %s | %s | %s | %s\n' "$UI_MARK" "$UI_ENGINE" "$UI_COMPONENT" "$UI_VERSION" "$UI_STATUS"
  else
    printf '%s | %s | %s | %s\n' "$UI_MARK" "$UI_ENGINE" "$UI_COMPONENT" "$UI_STATUS"
  fi
}

ui_progress() {
  if [ "$UI_UTF8" = "1" ]; then
    ui_line '↻' "$UI_CYAN" "$1" "$2" "$3" "$4"
  else
    UI_ASCII_STATUS=$(printf '%s' "$4" | sed 's/…/.../g')
    ui_line '..' '' "$1" "$2" "$3" "$UI_ASCII_STATUS"
  fi
}

ui_ok() {
  if [ "$UI_UTF8" = "1" ]; then
    ui_line '✓' "$UI_GREEN" "$1" "$2" "$3" "$4"
  else
    ui_line 'OK' '' "$1" "$2" "$3" "$4"
  fi
}

ui_fail() {
  if [ "$UI_UTF8" = "1" ]; then
    ui_line '✗' "$UI_RED" "$1" "$2" "$3" "$4" >&2
  else
    ui_line 'FAIL' '' "$1" "$2" "$3" "$4" >&2
  fi
}

ui_warn() {
  if [ "$UI_UTF8" = "1" ]; then
    ui_line '!' "$UI_YELLOW" "$1" "$2" "$3" "$4"
  else
    ui_line 'WARN' '' "$1" "$2" "$3" "$4"
  fi
}

ui_header() {
  if [ "$UI_UTF8" = "1" ]; then
    printf '\n%s╭─ CODEX ORCHESTRATOR · HOST SETUP%s\n' "$UI_BOLD" "$UI_RESET"
    printf '│ %s · %s\n' "$HOST_LABEL" "$INSTALL_LABEL"
    printf '│ %s\n' "$BIN_DIR"
    printf '╰─────────────────────────────────────────────\n\n'
  else
    printf '\n== CODEX ORCHESTRATOR / HOST SETUP ==\n'
    printf '   %s | %s | %s\n\n' "$HOST_LABEL" "$INSTALL_LABEL" "$BIN_DIR"
  fi
}

ui_divider() {
  if [ "$UI_UTF8" = "1" ]; then
    printf '%s──────────────────────────────────────────────%s\n' "$UI_DIM" "$UI_RESET"
  else
    printf '%s\n' '----------------------------------------------'
  fi
}

ui_result_ok() {
  if [ "$UI_UTF8" = "1" ]; then
    printf '%s%s%s · %s\n' "$UI_GREEN$UI_BOLD" "$1" "$UI_RESET" "$2"
  else
    printf '%s | %s\n' "$1" "$2"
  fi
}

ui_result_fail() {
  if [ "$UI_UTF8" = "1" ]; then
    printf '%s%s%s · %s\n' "$UI_RED$UI_BOLD" "$1" "$UI_RESET" "$2" >&2
  else
    printf '%s | %s\n' "$1" "$2" >&2
  fi
}

ui_hint() {
  printf '  %s\n' "$1"
}

ui_path_hint() {
  # $PATH must remain literal for the parent shell.
  # shellcheck disable=SC2016
  printf '  Before running: export PATH="%s:$PATH"\n' "$BIN_ROOT"
}

show_step_log() {
  if [ -n "$STEP_LOG" ] && [ -s "$STEP_LOG" ]; then
    tail -n 20 "$STEP_LOG" | sed 's/^/      /' >&2
  fi
}

cleanup() {
  for CLEAN_PATH in "$BUNDLE_FILE" "$BIN_TMP" "$STEP_LOG" "$NODE_SHIM_TMP" "$NPM_SHIM_TMP"; do
    if [ -n "$CLEAN_PATH" ]; then rm -f "$CLEAN_PATH"; fi
  done
}

on_exit() {
  INSTALL_EXIT=$?
  trap - EXIT INT TERM
  cleanup
  if [ "$INSTALL_EXIT" != "0" ] && [ "$INSTALL_FINISHED" = "0" ]; then
    ui_divider
    ui_result_fail "INCOMPLETE" "Setup stopped before every requested component was ready"
    if [ "$INSTALL_CONTEXT" = "installer" ]; then
      ui_hint "This single-use installer was consumed. Fix the cause, then mint and run a fresh installer."
    fi
  fi
  exit "$INSTALL_EXIT"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

CONFIG_HOME=\${XDG_CONFIG_HOME:-$HOME/.config}
DATA_HOME=\${XDG_DATA_HOME:-$HOME/.local/share}
CONFIG_PATH="$CONFIG_HOME/codex-orchestrator/$CONFIG_FILE"
case "$CONFIG_ENV" in
  CDX_CONFIG_PATH)
    if [ -n "\${CDX_CONFIG_PATH:-}" ]; then CONFIG_PATH=$CDX_CONFIG_PATH; fi
    ;;
  CLX_CONFIG_PATH)
    if [ -n "\${CLX_CONFIG_PATH:-}" ]; then CONFIG_PATH=$CLX_CONFIG_PATH; fi
    ;;
esac

CURL_INSECURE_FLAG=
if [ "\${CODEX_INSTALL_CURL_INSECURE:-0}" = "1" ]; then
  CURL_INSECURE_FLAG=-k
fi

INSTALL_WITH_SUDO=0
ensure_bin_root() {
  if [ "$INSTALL_CONTEXT" = "transition" ]; then
    mkdir -p "$BIN_ROOT"
    return 0
  fi
  if mkdir -p "$BIN_ROOT" 2>/dev/null && [ -w "$BIN_ROOT" ]; then
    return 0
  fi
  if [ -d "$BIN_ROOT" ] && [ -w "$BIN_ROOT" ]; then
    return 0
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo mkdir -p "$BIN_ROOT"
    INSTALL_WITH_SUDO=1
    return 0
  fi
  echo "Cannot install $NAME into $BIN_ROOT without write access or passwordless sudo." >&2
  echo "Run with sudo, configure passwordless sudo, or explicitly set BIN_DIR for a per-user install." >&2
  exit 1
}

install_bin() {
  src=$1
  dst=$2
  if [ -L "$dst" ]; then
    if [ "$INSTALL_WITH_SUDO" = "1" ]; then
      sudo rm -f "$dst"
    else
      rm -f "$dst"
    fi
  fi
  if [ "$INSTALL_WITH_SUDO" = "1" ]; then
    sudo install -m 755 "$src" "$dst"
  else
    cp "$src" "$dst"
    chmod 755 "$dst"
  fi
}

remove_installed_bin() {
  REMOVE_PATH=$1
  if [ "$INSTALL_WITH_SUDO" = "1" ]; then
    sudo -n rm -f "$REMOVE_PATH"
  else
    rm -f "$REMOVE_PATH"
  fi
}

run_privileged() {
  if [ "$(id -u)" = "0" ]; then
    "$@"
    return
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo -n "$@"
    return
  fi
  return 126
}

run_install_context() {
  if [ "$INSTALL_WITH_SUDO" = "1" ]; then
    sudo -n "$@"
  else
    "$@"
  fi
}

package_manager() {
  for PACKAGE_TOOL in apt-get dnf yum apk pacman zypper brew; do
    if command -v "$PACKAGE_TOOL" >/dev/null 2>&1; then
      printf '%s\n' "$PACKAGE_TOOL"
      return 0
    fi
  done
  return 1
}

install_os_component() {
  PACKAGE_KIND=$1
  PACKAGE_TOOL=$(package_manager) || return 1
  case "$PACKAGE_TOOL:$PACKAGE_KIND" in
    apt-get:node) PACKAGE_NAMES='nodejs' ;;
    apt-get:npm) PACKAGE_NAMES='npm' ;;
    dnf:node|yum:node|apk:node|pacman:node|zypper:node) PACKAGE_NAMES='nodejs' ;;
    dnf:npm|yum:npm|apk:npm|pacman:npm|zypper:npm) PACKAGE_NAMES='npm' ;;
    brew:node|brew:npm) PACKAGE_NAMES='node' ;;
    *) return 1 ;;
  esac

  : > "$STEP_LOG"
  case "$PACKAGE_TOOL" in
    apt-get)
      if run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $PACKAGE_NAMES >>"$STEP_LOG" 2>&1; then
        return 0
      fi
      run_privileged apt-get update >>"$STEP_LOG" 2>&1 &&
        run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
    dnf)
      run_privileged dnf install -y --setopt=install_weak_deps=False $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
    yum)
      run_privileged yum install -y $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
    apk)
      run_privileged apk add --no-cache $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
    pacman)
      run_privileged pacman -S --noconfirm --needed $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
    zypper)
      run_privileged zypper --non-interactive install --no-recommends $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
    brew)
      brew install $PACKAGE_NAMES >>"$STEP_LOG" 2>&1
      ;;
  esac
}

ensure_node_command() {
  if command -v node >/dev/null 2>&1; then return 0; fi
  NODEJS_BIN=$(command -v nodejs 2>/dev/null || true)
  if [ -z "$NODEJS_BIN" ]; then return 1; fi
  NODE_SHIM_TMP=$(mktemp "\${TMPDIR:-/tmp}/node.shim.XXXXXX")
  printf '#!/bin/sh\nexec "%s" "$@"\n' "$NODEJS_BIN" > "$NODE_SHIM_TMP"
  chmod 755 "$NODE_SHIM_TMP"
  install_bin "$NODE_SHIM_TMP" "$BIN_ROOT/node"
  hash -r 2>/dev/null || true
  command -v node >/dev/null 2>&1
}

install_corepack_npm() {
  COREPACK_BIN=$(command -v corepack 2>/dev/null || true)
  if [ -z "$COREPACK_BIN" ]; then return 1; fi
  case "$BIN_ROOT" in
    */bin) NPM_PREFIX=\${BIN_ROOT%/bin} ;;
    *) NPM_PREFIX="$DATA_HOME/codex-orchestrator/npm" ;;
  esac
  COREPACK_HOME="$NPM_PREFIX/lib/codex-orchestrator/corepack"
  NPM_SHIM_TMP=$(mktemp "\${TMPDIR:-/tmp}/npm.shim.XXXXXX")
  python3 - "$NPM_SHIM_TMP" "$COREPACK_BIN" "$COREPACK_HOME" "$NPM_PREFIX" <<'PY'
import os
import shlex
import sys

path, corepack, corepack_home, prefix = sys.argv[1:5]
with open(path, "w", encoding="utf-8") as fh:
    fh.write("#!/bin/sh\\n")
    fh.write(f"export COREPACK_HOME={shlex.quote(corepack_home)}\\n")
    fh.write(f"export npm_config_prefix={shlex.quote(prefix)}\\n")
    fh.write(f'exec {shlex.quote(corepack)} npm@10.9.2 "$@"\\n')
os.chmod(path, 0o755)
PY
  install_bin "$NPM_SHIM_TMP" "$BIN_ROOT/npm"
  hash -r 2>/dev/null || true
  : > "$STEP_LOG"
  if run_install_context "$BIN_ROOT/npm" --version >>"$STEP_LOG" 2>&1; then
    return 0
  fi
  remove_installed_bin "$BIN_ROOT/npm"
  hash -r 2>/dev/null || true
  return 1
}

read_claude_prerequisite_versions() {
  NODE_VERSION=$(node --version 2>/dev/null) || return 1
  NPM_VERSION=$(npm --version 2>/dev/null) || return 1
  NODE_VERSION=$(printf '%s\n' "$NODE_VERSION" | head -n 1)
  NPM_VERSION=$(printf '%s\n' "$NPM_VERSION" | head -n 1)
  [ -n "$NODE_VERSION" ] && [ -n "$NPM_VERSION" ]
}

cached_engine_cli() {
  case "$1" in
    cdx) CLI_CACHE="$HOME/.config/codex-orchestrator/cdx-codex-bin" ;;
    clx) CLI_CACHE="$HOME/.clx/state/claude-bin" ;;
    *) return 1 ;;
  esac
  if [ ! -r "$CLI_CACHE" ]; then return 1; fi
  CACHED_CLI=$(head -n 1 "$CLI_CACHE" 2>/dev/null || true)
  if [ ! -x "$CACHED_CLI" ]; then return 1; fi
  printf '%s\n' "$CACHED_CLI"
}

ensure_claude_prerequisites() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 &&
    read_claude_prerequisite_versions; then
    ui_ok "clx" "prerequisites" "$NODE_VERSION / npm $NPM_VERSION" "ready"
    return 0
  fi

  ui_progress "clx" "prerequisites" "" "preparing Node.js + npm"
  if ! command -v node >/dev/null 2>&1 && ! command -v nodejs >/dev/null 2>&1; then
    if ! install_os_component node; then
      ui_fail "clx" "prerequisites" "" "Node.js install failed"
      show_step_log
      return 1
    fi
  fi
  if ! ensure_node_command; then
    ui_fail "clx" "prerequisites" "" "Node.js is unavailable after install"
    show_step_log
    return 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    if ! install_corepack_npm && ! install_os_component npm; then
      ui_fail "clx" "prerequisites" "" "npm install failed"
      show_step_log
      return 1
    fi
    hash -r 2>/dev/null || true
  fi
  if ! command -v npm >/dev/null 2>&1; then
    ui_fail "clx" "prerequisites" "" "npm is unavailable after install"
    show_step_log
    return 1
  fi

  if ! read_claude_prerequisite_versions; then
    ui_fail "clx" "prerequisites" "" "Node.js/npm version check failed"
    return 1
  fi
  ui_ok "clx" "prerequisites" "$NODE_VERSION / npm $NPM_VERSION" "ready"
}

bootstrap_engine() {
  BOOT_BIN=$1
  BOOT_NAME=$2
  BOOT_CLI=$3
  BOOT_FAILED=0

  ui_progress "$BOOT_NAME" "auto-update" "" "scheduling"
  : > "$STEP_LOG"
  if CODEX_ORCH_PEER_SPAWN=1 "$BOOT_BIN" --minimal --cron install >"$STEP_LOG" 2>&1; then
    ui_ok "$BOOT_NAME" "auto-update" "" "scheduled"
  else
    ui_fail "$BOOT_NAME" "auto-update" "" "schedule failed"
    show_step_log
    BOOT_FAILED=1
  fi

  ui_progress "$BOOT_NAME" "$BOOT_CLI" "" "installing…"
  : > "$STEP_LOG"
  if CODEX_ORCH_PEER_SPAWN=1 "$BOOT_BIN" --minimal --cron run >"$STEP_LOG" 2>&1; then
    BOOT_CLI_BIN=$(command -v "$BOOT_CLI" 2>/dev/null || true)
    if [ -z "$BOOT_CLI_BIN" ]; then
      BOOT_CLI_BIN=$(cached_engine_cli "$BOOT_NAME" || true)
    fi
    if [ -n "$BOOT_CLI_BIN" ]; then
      if BOOT_VERSION=$("$BOOT_CLI_BIN" --version 2>/dev/null) && [ -n "$BOOT_VERSION" ]; then
        BOOT_VERSION=$(printf '%s\n' "$BOOT_VERSION" | head -n 1)
        ui_ok "$BOOT_NAME" "$BOOT_CLI" "$BOOT_VERSION" "ready"
      else
        ui_fail "$BOOT_NAME" "$BOOT_CLI" "" "version check failed"
        BOOT_FAILED=1
      fi
    else
      ui_fail "$BOOT_NAME" "$BOOT_CLI" "" "command unavailable after bootstrap"
      show_step_log
      BOOT_FAILED=1
    fi
  else
    ui_fail "$BOOT_NAME" "$BOOT_CLI" "" "install failed"
    show_step_log
    BOOT_FAILED=1
  fi

  [ "$BOOT_FAILED" = "0" ]
}

if [ "$INSTALL_CONTEXT" = "transition" ]; then
  BIN_ROOT="$DATA_HOME/codex-orchestrator/bin"
else
  BIN_ROOT="$BIN_DIR"
fi

mkdir -p "$(dirname "$CONFIG_PATH")"
ensure_bin_root
BIN_ROOT_ON_PATH=0
case ":$PARENT_PATH:" in
  *":$BIN_ROOT:"*) BIN_ROOT_ON_PATH=1 ;;
esac
ORIGINAL_RESOLVED_BIN=$(command -v "$NAME" 2>/dev/null || true)
PATH="$BIN_ROOT:\${PATH:-}"
export PATH
if [ "$INSTALL_CONTEXT" = "installer" ]; then
  ui_header
fi
BUNDLE_FILE=$(mktemp "\${TMPDIR:-/tmp}/$NAME.config.XXXXXX")
BIN_TMP=$(mktemp "\${TMPDIR:-/tmp}/$NAME.bin.XXXXXX")
STEP_LOG=$(mktemp "\${TMPDIR:-/tmp}/$NAME.install.XXXXXX")

if [ "$INSTALL_CONTEXT" = "installer" ] && [ "$NEEDS_CLAUDE" = "1" ]; then
  if ! ensure_claude_prerequisites; then
    exit 1
  fi
fi

PLATFORM_OS=$(uname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')
case "$PLATFORM_OS" in
  darwin) PLATFORM_OS=darwin ;;
  linux) PLATFORM_OS=linux ;;
  *) PLATFORM_OS=linux ;;
esac
PLATFORM_ARCH=$(uname -m 2>/dev/null)
case "$PLATFORM_ARCH" in
  x86_64|amd64) PLATFORM_ARCH=amd64 ;;
  arm64|aarch64) PLATFORM_ARCH=arm64 ;;
  *) PLATFORM_ARCH=amd64 ;;
esac
WRAPPER_PLATFORM="$PLATFORM_OS-$PLATFORM_ARCH"

ui_progress "$NAME" "wrapper" "" "installing…"
curl $CURL_INSECURE_FLAG -fsSL \\
  -H "X-API-Key: $HOST_API_KEY" \\
  -H "X-Wrapper-Platform: $WRAPPER_PLATFORM" \\
  "$BASE_URL/wrapper/v2/config?engine=$ENGINE" \\
  -o "$BUNDLE_FILE"

PY_OUT=$(python3 - "$BUNDLE_FILE" "$CONFIG_PATH" "$BIN_ROOT" "$NAME" "$INSTALL_CONTEXT" <<'PY'
import json
import os
import shlex
import sys

bundle_path, config_path, bin_root, name, mode = sys.argv[1:6]

def sort_value(value):
    if isinstance(value, list):
        return [sort_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_value(value[k]) for k in sorted(value)}
    return value

with open(bundle_path, "r", encoding="utf-8") as fh:
    bundle = json.load(fh)

payload = bundle.get("payload")
signature = bundle.get("signature") or {}
if not isinstance(payload, dict):
    raise SystemExit("wrapper config payload missing")

sig_value = signature.get("value")
if not isinstance(sig_value, str) or not sig_value:
    raise SystemExit("wrapper config signature missing")

wrapper = payload.get("wrapper") or {}
version = str(wrapper.get("version") or "")
binary_url = str(wrapper.get("binary_url") or "")
binary_sha256 = str(wrapper.get("binary_sha256") or "")
if not version or not binary_url or len(binary_sha256) != 64:
    raise SystemExit("wrapper binary metadata incomplete")

canonical = json.dumps(sort_value(payload), ensure_ascii=False, separators=(",", ":"))
os.makedirs(os.path.dirname(config_path), exist_ok=True)
tmp_config = f"{config_path}.tmp.{os.getpid()}"
tmp_sig = f"{config_path}.sig.tmp.{os.getpid()}"
with open(tmp_config, "w", encoding="utf-8") as fh:
    fh.write(canonical)
with open(tmp_sig, "w", encoding="utf-8") as fh:
    fh.write(sig_value)
os.replace(tmp_config, config_path)
os.replace(tmp_sig, config_path + ".sig")
os.chmod(config_path, 0o600)
os.chmod(config_path + ".sig", 0o600)

target = os.path.join(bin_root, f"{name}-{version}") if mode == "transition" else os.path.join(bin_root, name)
print(f"WRAPPER_VERSION={shlex.quote(version)}")
print(f"BINARY_URL={shlex.quote(binary_url)}")
print(f"BINARY_SHA256={shlex.quote(binary_sha256)}")
print(f"TARGET_BIN={shlex.quote(target)}")
PY
)
eval "$PY_OUT"

case "$BINARY_URL" in
  http://*|https://*) ;;
  /*) BINARY_URL="$BASE_URL$BINARY_URL" ;;
  *) BINARY_URL="$BASE_URL/$BINARY_URL" ;;
esac

sha256_file() {
  python3 - "$1" <<'PY'
import hashlib
import sys

h = hashlib.sha256()
with open(sys.argv[1], "rb") as fh:
    for chunk in iter(lambda: fh.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
}

same_path() {
  python3 - "$1" "$2" <<'PY' >/dev/null 2>&1
import os
import sys

try:
    if os.path.exists(sys.argv[1]) and os.path.exists(sys.argv[2]) and os.path.samefile(sys.argv[1], sys.argv[2]):
        raise SystemExit(0)
except OSError:
    pass
raise SystemExit(1)
PY
}

remove_relic() {
  relic=$1
  if [ "$relic" = "$TARGET_BIN" ] || same_path "$relic" "$TARGET_BIN" || [ ! -e "$relic" ]; then
    return 0
  fi
  RELIC_SHA=$(sha256_file "$relic" 2>/dev/null || true)
  if [ "$RELIC_SHA" = "$BINARY_SHA256" ] || [ "$RELIC_SHA" = "" ]; then
    label="duplicate"
  else
    label="stale"
  fi
  if [ -w "$relic" ]; then
    rm -f "$relic"
    echo ">> Removed $label wrapper relic $relic"
  elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    sudo rm -f "$relic"
    echo ">> Removed $label wrapper relic $relic via sudo"
  else
    echo ">> $label wrapper relic remains; remove it with: sudo rm -f $relic"
  fi
}

cleanup_known_relics() {
  if [ "$INSTALL_CONTEXT" != "installer" ]; then
    return 0
  fi
  if [ "$BIN_ROOT" != "/usr/local/bin" ]; then
    return 0
  fi
  for RELIC_BIN in "$HOME/.local/bin/$NAME" "/usr/local/sbin/$NAME"; do
    remove_relic "$RELIC_BIN"
  done
}

SKIP_DOWNLOAD=0
if [ -x "$TARGET_BIN" ] && [ ! -L "$TARGET_BIN" ]; then
  EXISTING_SHA=$(sha256_file "$TARGET_BIN" || true)
  if [ "$EXISTING_SHA" = "$BINARY_SHA256" ]; then
    if [ "$INSTALL_CONTEXT" = "transition" ]; then
      exec "$TARGET_BIN" "$@"
    fi
    cleanup_known_relics
    SKIP_DOWNLOAD=1
  fi
fi

if [ "$SKIP_DOWNLOAD" = "0" ]; then
  curl $CURL_INSECURE_FLAG -fsSL \\
    -H "X-API-Key: $HOST_API_KEY" \\
    -H "X-Wrapper-Platform: $WRAPPER_PLATFORM" \\
    "$BINARY_URL" \\
    -o "$BIN_TMP"

  ACTUAL_SHA=$(sha256_file "$BIN_TMP")
  if [ "$ACTUAL_SHA" != "$BINARY_SHA256" ]; then
    echo "Downloaded wrapper checksum mismatch for $NAME $WRAPPER_VERSION" >&2
    echo "expected: $BINARY_SHA256" >&2
    echo "actual:   $ACTUAL_SHA" >&2
    exit 1
  fi

  chmod 755 "$BIN_TMP"
  install_bin "$BIN_TMP" "$TARGET_BIN"
  rm -f "$BIN_TMP"
  cleanup_known_relics

  if [ "$INSTALL_CONTEXT" = "transition" ]; then
    exec "$TARGET_BIN" "$@"
  fi

fi
if [ -n "$ORIGINAL_RESOLVED_BIN" ] && [ "$ORIGINAL_RESOLVED_BIN" != "$TARGET_BIN" ]; then
  ui_warn "$NAME" "PATH" "$ORIGINAL_RESOLVED_BIN" "expected $TARGET_BIN"
  ui_hint "Refresh the parent shell: hash -r; or run directly: $TARGET_BIN run"
fi
ui_ok "$NAME" "wrapper" "$WRAPPER_VERSION" "ready"

if [ "$NAME" = "clx" ]; then
  PRIMARY_CLI=claude
else
  PRIMARY_CLI=codex
fi
if ! bootstrap_engine "$TARGET_BIN" "$NAME" "$PRIMARY_CLI"; then
  INSTALL_FAILED=1
fi${peerSection}`;
}

function peerInstallBlock(engine: Engine): string {
  const peerName = binaryName(engine);
  const peerConfigFile = `${peerName}.json`;
  const peerConfigEnv = engine === ENGINE_CLAUDE ? 'CLX_CONFIG_PATH' : 'CDX_CONFIG_PATH';
  return `

# 3. Install peer wrapper: ${peerName}
PEER_NAME=${shellQuote(peerName)}
set +e
(
  set -e
  PEER_ENGINE=${shellQuote(engine)}
  PEER_CONFIG_FILE=${shellQuote(peerConfigFile)}
  PEER_CONFIG_ENV=${shellQuote(peerConfigEnv)}
  PEER_CONFIG_HOME=\${XDG_CONFIG_HOME:-$HOME/.config}
  PEER_CONFIG_PATH="$PEER_CONFIG_HOME/codex-orchestrator/$PEER_CONFIG_FILE"
  case "$PEER_CONFIG_ENV" in
    CDX_CONFIG_PATH)
      if [ -n "\${CDX_CONFIG_PATH:-}" ]; then PEER_CONFIG_PATH=$CDX_CONFIG_PATH; fi
      ;;
    CLX_CONFIG_PATH)
      if [ -n "\${CLX_CONFIG_PATH:-}" ]; then PEER_CONFIG_PATH=$CLX_CONFIG_PATH; fi
      ;;
  esac
  PEER_BIN_DIR="$(dirname "$TARGET_BIN")"
  mkdir -p "$(dirname "$PEER_CONFIG_PATH")"
  PEER_BUNDLE=$(mktemp "\${TMPDIR:-/tmp}/$PEER_NAME.config.XXXXXX")
  PEER_BIN_TMP=$(mktemp "\${TMPDIR:-/tmp}/$PEER_NAME.bin.XXXXXX")
  peer_cleanup() { rm -f "$PEER_BUNDLE" "$PEER_BIN_TMP"; }
  trap peer_cleanup EXIT INT TERM
  ui_progress "$PEER_NAME" "wrapper" "" "installing…"
  curl $CURL_INSECURE_FLAG -fsSL \\
    -H "X-API-Key: $HOST_API_KEY" \\
    -H "X-Wrapper-Platform: $WRAPPER_PLATFORM" \\
    "$BASE_URL/wrapper/v2/config?engine=$PEER_ENGINE" \\
    -o "$PEER_BUNDLE"
  PEER_PY_OUT=$(python3 - "$PEER_BUNDLE" "$PEER_CONFIG_PATH" "$PEER_BIN_DIR" "$PEER_NAME" installer <<'PY'
import json
import os
import shlex
import sys

bundle_path, config_path, bin_root, name, mode = sys.argv[1:6]

def sort_value(value):
    if isinstance(value, list):
        return [sort_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_value(value[k]) for k in sorted(value)}
    return value

with open(bundle_path, "r", encoding="utf-8") as fh:
    bundle = json.load(fh)

payload = bundle.get("payload")
signature = bundle.get("signature") or {}
if not isinstance(payload, dict):
    raise SystemExit("peer wrapper config payload missing")

sig_value = signature.get("value")
if not isinstance(sig_value, str) or not sig_value:
    raise SystemExit("peer wrapper config signature missing")

wrapper = payload.get("wrapper") or {}
version = str(wrapper.get("version") or "")
binary_url = str(wrapper.get("binary_url") or "")
binary_sha256 = str(wrapper.get("binary_sha256") or "")
if not version or not binary_url or len(binary_sha256) != 64:
    raise SystemExit("peer wrapper binary metadata incomplete")

canonical = json.dumps(sort_value(payload), ensure_ascii=False, separators=(",", ":"))
os.makedirs(os.path.dirname(config_path), exist_ok=True)
tmp_config = f"{config_path}.tmp.{os.getpid()}"
tmp_sig = f"{config_path}.sig.tmp.{os.getpid()}"
with open(tmp_config, "w", encoding="utf-8") as fh:
    fh.write(canonical)
with open(tmp_sig, "w", encoding="utf-8") as fh:
    fh.write(sig_value)
os.replace(tmp_config, config_path)
os.replace(tmp_sig, config_path + ".sig")
os.chmod(config_path, 0o600)
os.chmod(config_path + ".sig", 0o600)

target = os.path.join(bin_root, name)
print(f"PEER_WRAPPER_VERSION={shlex.quote(version)}")
print(f"PEER_BINARY_URL={shlex.quote(binary_url)}")
print(f"PEER_BINARY_SHA256={shlex.quote(binary_sha256)}")
print(f"PEER_TARGET_BIN={shlex.quote(target)}")
PY
  )
  eval "$PEER_PY_OUT"
  case "$PEER_BINARY_URL" in
    http://*|https://*) ;;
    /*) PEER_BINARY_URL="$BASE_URL$PEER_BINARY_URL" ;;
    *) PEER_BINARY_URL="$BASE_URL/$PEER_BINARY_URL" ;;
  esac
  PEER_SKIP=0
  if [ -x "$PEER_TARGET_BIN" ] && [ ! -L "$PEER_TARGET_BIN" ]; then
    PEER_SHA=$(sha256_file "$PEER_TARGET_BIN" || true)
    if [ "$PEER_SHA" = "$PEER_BINARY_SHA256" ]; then
      PEER_SKIP=1
    fi
  fi
  if [ "$PEER_SKIP" = "0" ]; then
    curl $CURL_INSECURE_FLAG -fsSL \\
      -H "X-API-Key: $HOST_API_KEY" \\
      -H "X-Wrapper-Platform: $WRAPPER_PLATFORM" \\
      "$PEER_BINARY_URL" \\
      -o "$PEER_BIN_TMP"
    PEER_ACTUAL_SHA=$(sha256_file "$PEER_BIN_TMP")
    if [ "$PEER_ACTUAL_SHA" != "$PEER_BINARY_SHA256" ]; then
      echo "Downloaded peer wrapper checksum mismatch for $PEER_NAME" >&2
      exit 1
    fi
    chmod 755 "$PEER_BIN_TMP"
    install_bin "$PEER_BIN_TMP" "$PEER_TARGET_BIN"
    rm -f "$PEER_BIN_TMP"
  fi
  ui_ok "$PEER_NAME" "wrapper" "$PEER_WRAPPER_VERSION" "ready"
  if [ "$PEER_NAME" = "clx" ]; then
    PEER_CLI=claude
  else
    PEER_CLI=codex
  fi
  bootstrap_engine "$PEER_TARGET_BIN" "$PEER_NAME" "$PEER_CLI"
)
PEER_EXIT=$?
set -e
if [ "$PEER_EXIT" != "0" ]; then
  ui_fail "$PEER_NAME" "setup" "" "failed"
  INSTALL_FAILED=1
fi`;
}

function binaryName(engine: Engine): 'cdx' | 'clx' {
  return engine === ENGINE_CLAUDE ? 'clx' : 'cdx';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commentValue(value: string): string {
  return value.replace(/[\r\n]/g, ' ').trim();
}
