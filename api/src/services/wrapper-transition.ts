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

export function isCxxBinaryUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const path = new URL(value, 'https://wrapper.invalid').pathname;
    return /\/wrapper\/v2\/bin\/cxx\/(?:linux|darwin)-(?:amd64|arm64)\/v[^/]+\/cxx$/.test(
      path,
    );
  } catch {
    return false;
  }
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
  const defaultCurlInsecure = opts.allowInsecure ? '1' : '0';

  return `#!/bin/sh
# Codex Orchestrator wrapper-v2 installer for ${name}.
# Generated for host ${commentValue(opts.fqdn)}.
set -eu

BASE_URL=${shellQuote(opts.baseUrl.replace(/\/+$/, ''))}
HOST_API_KEY=${shellQuote(opts.apiKey)}
ENGINE=${shellQuote(opts.engine)}
NAME=${shellQuote(name)}
HOST_LABEL=${shellQuote(opts.fqdn)}
INSTALL_LABEL=${shellQuote(installLabel)}
NEEDS_CLAUDE=${needsClaude ? '1' : '0'}
HAS_CODEX=${hasCodex ? '1' : '0'}
HAS_CLAUDE=${needsClaude ? '1' : '0'}
INSTALL_CONTEXT=installer
CODEX_INSTALL_CURL_INSECURE=\${CODEX_INSTALL_CURL_INSECURE:-${defaultCurlInsecure}}

BIN_DIR=\${BIN_DIR:-/usr/local/bin}

# Pull every requested signed host config, install the common wrapper once,
# then let the host-wide coordinator bootstrap every enabled engine once.
${bootstrapBody()}

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
ui_hint "Retry host cron:    $BIN_ROOT/cxx cron install"
ui_hint "Retry engine CLIs:  $BIN_ROOT/cxx cron run --minimal"
ui_hint "If wrapper/config installation failed, mint a fresh single-use installer."
exit 1
`;
}

export function buildLegacyWrapperTransitionScript(opts: {
  fqdn: string;
  apiKey: string;
  baseUrl: string;
  engine: Engine;
  allowInsecure?: boolean;
  peerEngines?: Engine[];
}): string {
  const name = binaryName(opts.engine);
  const peers = (opts.peerEngines ?? []).filter((engine) => engine !== opts.engine);
  const requestedEngines = [...new Set<Engine>([opts.engine, ...peers])];
  const hasCodex = requestedEngines.some((engine) => engine !== ENGINE_CLAUDE);
  const hasClaude = requestedEngines.includes(ENGINE_CLAUDE);
  return `#!/bin/sh
# Codex Orchestrator legacy transition launcher for ${name}.
# Generated for host ${commentValue(opts.fqdn)}.
set -eu

BASE_URL=${shellQuote(opts.baseUrl.replace(/\/+$/, ''))}
HOST_API_KEY=${shellQuote(opts.apiKey)}
ENGINE=${shellQuote(opts.engine)}
NAME=${shellQuote(name)}
HOST_LABEL=${shellQuote(opts.fqdn)}
INSTALL_LABEL=${shellQuote(opts.engine === ENGINE_CLAUDE ? 'Claude' : 'Codex')}
NEEDS_CLAUDE=${hasClaude ? '1' : '0'}
HAS_CODEX=${hasCodex ? '1' : '0'}
HAS_CLAUDE=${hasClaude ? '1' : '0'}
CODEX_INSTALL_CURL_INSECURE=\${CODEX_INSTALL_CURL_INSECURE:-${opts.allowInsecure ? '1' : '0'}}
BIN_DIR=\${BIN_DIR:-/usr/local/bin}
INSTALL_CONTEXT=transition

${bootstrapBody()}
`;
}

function bootstrapBody(): string {
  return `PARENT_PATH=\${PATH:-}
if [ -z "$PARENT_PATH" ]; then
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
fi

INSTALL_FAILED=0
INSTALL_FINISHED=0
CODEX_BUNDLE=
CLAUDE_BUNDLE=
BIN_TMP=
STEP_LOG=
NODE_SHIM_TMP=
NPM_SHIM_TMP=
INSTALL_BIN_TMP=
ALIAS_TMP=
INSTALL_WITH_SUDO=0

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
  for CLEAN_PATH in "$CODEX_BUNDLE" "$CLAUDE_BUNDLE" "$BIN_TMP" "$STEP_LOG" "$NODE_SHIM_TMP" "$NPM_SHIM_TMP"; do
    if [ -n "$CLEAN_PATH" ]; then rm -f "$CLEAN_PATH"; fi
  done
  for CLEAN_PATH in "$INSTALL_BIN_TMP" "$ALIAS_TMP"; do
    if [ -z "$CLEAN_PATH" ]; then continue; fi
    if [ "$INSTALL_WITH_SUDO" = "1" ]; then
      sudo -n rm -f "$CLEAN_PATH" >/dev/null 2>&1 || true
    else
      rm -f "$CLEAN_PATH" || true
    fi
  done
}

# Invoked indirectly by the EXIT/INT/TERM traps below.
# shellcheck disable=SC2329
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
CODEX_CONFIG_PATH=\${CDX_CONFIG_PATH:-$CONFIG_HOME/codex-orchestrator/cdx.json}
CLAUDE_CONFIG_PATH=\${CLX_CONFIG_PATH:-$CONFIG_HOME/codex-orchestrator/clx.json}

CURL_INSECURE_FLAG=
if [ "\${CODEX_INSTALL_CURL_INSECURE:-0}" = "1" ]; then
  CURL_INSECURE_FLAG=-k
fi

ensure_bin_root() {
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
  if [ -d "$dst" ]; then
    echo "Cannot replace binary directory $dst" >&2
    return 1
  fi
  INSTALL_BIN_TMP="$dst.cxx-install.$$"
  if [ "$INSTALL_WITH_SUDO" = "1" ]; then
    sudo rm -f "$INSTALL_BIN_TMP"
    sudo install -m 755 "$src" "$INSTALL_BIN_TMP"
    sudo mv -f "$INSTALL_BIN_TMP" "$dst"
  else
    rm -f "$INSTALL_BIN_TMP"
    cp "$src" "$INSTALL_BIN_TMP"
    chmod 755 "$INSTALL_BIN_TMP"
    mv -f "$INSTALL_BIN_TMP" "$dst"
  fi
  INSTALL_BIN_TMP=
}

install_alias() {
  ALIAS_NAME=$1
  ALIAS_PATH="$BIN_ROOT/$ALIAS_NAME"
  ALIAS_TMP="$BIN_ROOT/.$ALIAS_NAME.cxx.$$"
  if [ -d "$ALIAS_PATH" ]; then
    echo "Cannot replace wrapper alias directory $ALIAS_PATH" >&2
    return 1
  fi
  if [ "$INSTALL_WITH_SUDO" = "1" ]; then
    sudo rm -f "$ALIAS_TMP"
    sudo ln -s cxx "$ALIAS_TMP"
    sudo mv -f "$ALIAS_TMP" "$ALIAS_PATH"
  else
    rm -f "$ALIAS_TMP"
    ln -s cxx "$ALIAS_TMP"
    mv -f "$ALIAS_TMP" "$ALIAS_PATH"
  fi
  ALIAS_TMP=
}

remove_disabled_alias() {
  ALIAS_NAME=$1
  ALIAS_PATH="$BIN_ROOT/$ALIAS_NAME"
  if [ ! -e "$ALIAS_PATH" ] && [ ! -L "$ALIAS_PATH" ]; then
    return 0
  fi
  if [ -d "$ALIAS_PATH" ] && [ ! -L "$ALIAS_PATH" ]; then
    echo "Disabled wrapper alias is a directory and was left intact: $ALIAS_PATH" >&2
    return 1
  fi
  if [ "$INSTALL_WITH_SUDO" = "1" ]; then
    sudo rm -f "$ALIAS_PATH"
  else
    rm -f "$ALIAS_PATH"
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

bootstrap_host() {
  HOST_BOOT_FAILED=0

  ui_progress "cxx" "auto-update" "" "scheduling"
  : > "$STEP_LOG"
  if "$TARGET_BIN" cron install --minimal >"$STEP_LOG" 2>&1; then
    ui_ok "cxx" "auto-update" "" "scheduled"
  else
    ui_fail "cxx" "auto-update" "" "schedule failed"
    show_step_log
    HOST_BOOT_FAILED=1
  fi

  ui_progress "cxx" "engine CLIs" "" "installing…"
  : > "$STEP_LOG"
  if "$TARGET_BIN" cron run --minimal >"$STEP_LOG" 2>&1; then
    ui_ok "cxx" "engine CLIs" "" "updated"
  else
    ui_fail "cxx" "engine CLIs" "" "update failed"
    show_step_log
    HOST_BOOT_FAILED=1
  fi

  [ "$HOST_BOOT_FAILED" = "0" ]
}

verify_engine_cli() {
  BOOT_NAME=$1
  BOOT_CLI=$2
  BOOT_CLI_BIN=$(command -v "$BOOT_CLI" 2>/dev/null || true)
  if [ -z "$BOOT_CLI_BIN" ]; then
    BOOT_CLI_BIN=$(cached_engine_cli "$BOOT_NAME" || true)
  fi
  if [ -z "$BOOT_CLI_BIN" ]; then
    ui_fail "$BOOT_NAME" "$BOOT_CLI" "" "command unavailable after bootstrap"
    return 1
  fi
  if ! BOOT_VERSION=$("$BOOT_CLI_BIN" --version 2>/dev/null) || [ -z "$BOOT_VERSION" ]; then
    ui_fail "$BOOT_NAME" "$BOOT_CLI" "" "version check failed"
    return 1
  fi
  BOOT_VERSION=$(printf '%s\n' "$BOOT_VERSION" | head -n 1)
  ui_ok "$BOOT_NAME" "$BOOT_CLI" "$BOOT_VERSION" "ready"
}

if [ "$INSTALL_CONTEXT" = "transition" ]; then
  case "$0" in
    */*) TRANSITION_SELF=$0 ;;
    *) TRANSITION_SELF=$(command -v "$0" 2>/dev/null || printf '%s' "$0") ;;
  esac
  TRANSITION_DIR=$(dirname "$TRANSITION_SELF")
  BIN_ROOT=$(CDPATH='' cd -P -- "$TRANSITION_DIR" 2>/dev/null && pwd)
  if [ -z "$BIN_ROOT" ]; then
    echo "Cannot resolve transition wrapper directory for $TRANSITION_SELF" >&2
    exit 1
  fi
else
  BIN_ROOT="$BIN_DIR"
fi

if [ "$HAS_CODEX" = "1" ]; then mkdir -p "$(dirname "$CODEX_CONFIG_PATH")"; fi
if [ "$HAS_CLAUDE" = "1" ]; then mkdir -p "$(dirname "$CLAUDE_CONFIG_PATH")"; fi
ensure_bin_root
BIN_ROOT_ON_PATH=0
case ":$PARENT_PATH:" in
  *":$BIN_ROOT:"*) BIN_ROOT_ON_PATH=1 ;;
esac
ORIGINAL_CODEX_BIN=$(command -v cdx 2>/dev/null || true)
ORIGINAL_CLAUDE_BIN=$(command -v clx 2>/dev/null || true)
PATH="$BIN_ROOT:\${PATH:-}"
export PATH
if [ "$INSTALL_CONTEXT" = "installer" ]; then
  ui_header
fi
BIN_TMP=$(mktemp "\${TMPDIR:-/tmp}/cxx.bin.XXXXXX")
STEP_LOG=$(mktemp "\${TMPDIR:-/tmp}/cxx.install.XXXXXX")
if [ "$HAS_CODEX" = "1" ]; then
  CODEX_BUNDLE=$(mktemp "\${TMPDIR:-/tmp}/cdx.config.XXXXXX")
fi
if [ "$HAS_CLAUDE" = "1" ]; then
  CLAUDE_BUNDLE=$(mktemp "\${TMPDIR:-/tmp}/clx.config.XXXXXX")
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

ui_progress "cxx" "config" "" "fetching enabled engines…"
if [ "$HAS_CODEX" = "1" ]; then
  curl $CURL_INSECURE_FLAG -fsSL \\
    -H "X-API-Key: $HOST_API_KEY" \\
    -H "X-Wrapper-Platform: $WRAPPER_PLATFORM" \\
    "$BASE_URL/wrapper/v2/config?engine=codex" \\
    -o "$CODEX_BUNDLE"
fi
if [ "$HAS_CLAUDE" = "1" ]; then
  curl $CURL_INSECURE_FLAG -fsSL \\
    -H "X-API-Key: $HOST_API_KEY" \\
    -H "X-Wrapper-Platform: $WRAPPER_PLATFORM" \\
    "$BASE_URL/wrapper/v2/config?engine=claude" \\
    -o "$CLAUDE_BUNDLE"
fi

# Validate every requested config before writing any of them. A dual-engine
# install is allowed only when both logical configs identify the same cxx
# version and SHA; otherwise no binary or alias is changed.
PY_OUT=$(python3 - "$BIN_ROOT" "$CODEX_BUNDLE" "$CODEX_CONFIG_PATH" "$CLAUDE_BUNDLE" "$CLAUDE_CONFIG_PATH" <<'PY'
import json
import os
import re
import shlex
import sys
from urllib.parse import urlsplit

bin_root, codex_bundle, codex_config, claude_bundle, claude_config = sys.argv[1:6]

def sort_value(value):
    if isinstance(value, list):
        return [sort_value(v) for v in value]
    if isinstance(value, dict):
        return {k: sort_value(value[k]) for k in sorted(value)}
    return value

entries = []
for engine, bundle_path, config_path in (
    ("codex", codex_bundle, codex_config),
    ("claude", claude_bundle, claude_config),
):
    if not bundle_path:
        continue
    with open(bundle_path, "r", encoding="utf-8") as fh:
        bundle = json.load(fh)
    payload = bundle.get("payload")
    signature = bundle.get("signature") or {}
    if not isinstance(payload, dict):
        raise SystemExit(f"{engine} wrapper config payload missing")
    sig_value = signature.get("value")
    if not isinstance(sig_value, str) or not sig_value:
        raise SystemExit(f"{engine} wrapper config signature missing")
    wrapper = payload.get("wrapper") or {}
    version = str(wrapper.get("version") or "")
    binary_url = str(wrapper.get("binary_url") or "")
    binary_sha256 = str(wrapper.get("binary_sha256") or "")
    if not version or not binary_url or not re.fullmatch(r"[0-9a-fA-F]{64}", binary_sha256):
        raise SystemExit(f"{engine} wrapper binary metadata incomplete")
    binary_path = urlsplit(binary_url).path
    if not re.search(
        r"/wrapper/v2/bin/cxx/(?:linux|darwin)-(?:amd64|arm64)/v[^/]+/cxx$",
        binary_path,
    ):
        raise SystemExit(
            f"{engine} wrapper config does not identify a canonical cxx artifact"
        )
    entries.append({
        "engine": engine,
        "config_path": config_path,
        "canonical": json.dumps(sort_value(payload), ensure_ascii=False, separators=(",", ":")),
        "signature": sig_value,
        "version": version,
        "binary_url": binary_url,
        "sha256": binary_sha256,
    })

if not entries:
    raise SystemExit("no enabled wrapper config requested")
identities = {(entry["version"], entry["sha256"]) for entry in entries}
if len(identities) != 1:
    details = ", ".join(
        f'{entry["engine"]}={entry["version"]}/{entry["sha256"]}' for entry in entries
    )
    raise SystemExit(f"enabled wrapper configs disagree on cxx version/SHA: {details}")

pending = []
try:
    for entry in entries:
        config_path = entry["config_path"]
        os.makedirs(os.path.dirname(config_path) or ".", exist_ok=True)
        tmp_config = f"{config_path}.tmp.{os.getpid()}"
        tmp_sig = f"{config_path}.sig.tmp.{os.getpid()}"
        with open(tmp_config, "w", encoding="utf-8") as fh:
            fh.write(entry["canonical"])
        with open(tmp_sig, "w", encoding="utf-8") as fh:
            fh.write(entry["signature"])
        os.chmod(tmp_config, 0o600)
        os.chmod(tmp_sig, 0o600)
        pending.append((tmp_config, config_path, tmp_sig, config_path + ".sig"))
    for tmp_config, config_path, tmp_sig, sig_path in pending:
        os.replace(tmp_config, config_path)
        os.replace(tmp_sig, sig_path)
finally:
    for tmp_config, _, tmp_sig, _ in pending:
        for tmp_path in (tmp_config, tmp_sig):
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass

selected = entries[0]
version = selected["version"]
binary_url = selected["binary_url"]
binary_sha256 = selected["sha256"]
target = os.path.join(bin_root, "cxx")
print(f"WRAPPER_VERSION={shlex.quote(version)}")
print(f"BINARY_URL={shlex.quote(binary_url)}")
print(f"BINARY_SHA256={shlex.quote(binary_sha256)}")
print(f"TARGET_BIN={shlex.quote(target)}")
PY
)
eval "$PY_OUT"
ui_ok "cxx" "config" "$WRAPPER_VERSION" "ready"

if [ "$INSTALL_CONTEXT" = "installer" ] && [ "$NEEDS_CLAUDE" = "1" ]; then
  if ! ensure_claude_prerequisites; then
    exit 1
  fi
fi

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
  if [ "$HAS_CODEX" = "1" ]; then
    for RELIC_BIN in "$HOME/.local/bin/cdx" "/usr/local/sbin/cdx"; do
      remove_relic "$RELIC_BIN"
    done
  fi
  if [ "$HAS_CLAUDE" = "1" ]; then
    for RELIC_BIN in "$HOME/.local/bin/clx" "/usr/local/sbin/clx"; do
      remove_relic "$RELIC_BIN"
    done
  fi
}

ui_progress "cxx" "wrapper" "" "installing…"
SKIP_DOWNLOAD=0
if [ -x "$TARGET_BIN" ] && [ ! -L "$TARGET_BIN" ]; then
  EXISTING_SHA=$(sha256_file "$TARGET_BIN" || true)
  if [ "$EXISTING_SHA" = "$BINARY_SHA256" ]; then
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
    echo "Downloaded wrapper checksum mismatch for cxx $WRAPPER_VERSION" >&2
    echo "expected: $BINARY_SHA256" >&2
    echo "actual:   $ACTUAL_SHA" >&2
    exit 1
  fi

  chmod 755 "$BIN_TMP"
  install_bin "$BIN_TMP" "$TARGET_BIN"
  rm -f "$BIN_TMP"
fi
if [ "$HAS_CODEX" = "1" ]; then install_alias cdx; fi
if [ "$HAS_CLAUDE" = "1" ]; then install_alias clx; fi
if [ "$INSTALL_CONTEXT" = "installer" ]; then
  if [ "$HAS_CODEX" = "0" ]; then remove_disabled_alias cdx; fi
  if [ "$HAS_CLAUDE" = "0" ]; then remove_disabled_alias clx; fi
fi
cleanup_known_relics
ui_ok "cxx" "wrapper" "$WRAPPER_VERSION" "ready"

install_agent_relay() {
  # Keep the relay installed while the fleet switch is off. It performs no
  # network work and starts no model in that state; the dormant service is what
  # lets the WebUI activate a provisioned host without another human install.
  ui_progress "cxx" "agent relay" "" "installing…"
  if "$TARGET_BIN" agent service install >"$STEP_LOG" 2>&1; then
    ui_ok "cxx" "agent relay" "" "ready"
  else
    ui_warn "cxx" "agent relay" "" "service unavailable"
    ui_hint "Retry as the desktop user: $TARGET_BIN agent service install"
  fi
}

if [ "$INSTALL_CONTEXT" = "transition" ]; then
  install_agent_relay
  INSTALL_FINISHED=1
  cleanup
  trap - EXIT INT TERM
  exec "$TARGET_BIN" "$ENGINE" "$@"
fi

if [ "$HAS_CODEX" = "1" ] && [ -n "$ORIGINAL_CODEX_BIN" ] && [ "$ORIGINAL_CODEX_BIN" != "$BIN_ROOT/cdx" ]; then
  ui_warn "cdx" "PATH" "$ORIGINAL_CODEX_BIN" "expected $BIN_ROOT/cdx"
  ui_hint "Refresh the parent shell: hash -r; or run directly: $BIN_ROOT/cdx run"
fi
if [ "$HAS_CLAUDE" = "1" ] && [ -n "$ORIGINAL_CLAUDE_BIN" ] && [ "$ORIGINAL_CLAUDE_BIN" != "$BIN_ROOT/clx" ]; then
  ui_warn "clx" "PATH" "$ORIGINAL_CLAUDE_BIN" "expected $BIN_ROOT/clx"
  ui_hint "Refresh the parent shell: hash -r; or run directly: $BIN_ROOT/clx run"
fi

if ! bootstrap_host; then INSTALL_FAILED=1; fi
if [ "$HAS_CODEX" = "1" ] && ! verify_engine_cli "cdx" "codex"; then INSTALL_FAILED=1; fi
if [ "$HAS_CLAUDE" = "1" ] && ! verify_engine_cli "clx" "claude"; then INSTALL_FAILED=1; fi
if [ "$INSTALL_FAILED" = "0" ]; then install_agent_relay; fi
# These are consumed by the installer suffix. Keep the shared transition body
# independently ShellCheck-clean even though its successful path execs above.
: "$BIN_ROOT_ON_PATH" "$INSTALL_FAILED"`;
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
