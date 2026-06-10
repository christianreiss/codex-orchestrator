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
  peerEngines?: Engine[];
}): string {
  if (!opts.apiKey) throw new Error('Installer host API key missing');
  if (!opts.fqdn) throw new Error('Installer host FQDN missing');

  const name = binaryName(opts.engine);
  const cliName = opts.engine === ENGINE_CLAUDE ? 'claude' : 'codex';
  const cliHint =
    opts.engine === ENGINE_CLAUDE
      ? `if ! command -v ${cliName} >/dev/null 2>&1; then
  if command -v npm >/dev/null 2>&1; then
    echo ">> claude not found — installing @anthropic-ai/claude-code via npm…"
    npm install -g @anthropic-ai/claude-code 2>/dev/null || \\
      sudo -n npm install -g @anthropic-ai/claude-code 2>/dev/null || \\
      { echo ">> npm install failed. Install manually: npm install -g @anthropic-ai/claude-code" >&2; exit 1; }
  else
    echo ">> claude not found and npm not available. Install Node.js + npm, then: npm install -g @anthropic-ai/claude-code" >&2
    exit 1
  fi
fi`
      : `command -v ${cliName} >/dev/null 2>&1 || echo ">> Install Codex CLI manually (e.g. via the upstream installer) and re-run."`;

  const peers = (opts.peerEngines ?? []).filter((e) => e !== opts.engine);
  const peerBlock = peers.length > 0 ? peers.map(peerInstallBlock).join('\n') : undefined;

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
INSTALL_CONTEXT=installer

BIN_DIR=\${BIN_DIR:-/usr/local/bin}
echo ">> Installing the ${name} wrapper into $BIN_DIR"

# 1. Friendly engine CLI hint (the wrapper invokes this binary).
${cliHint}

# 2. Pull the signed host config and the matching wrapper binary.
${bootstrapBody({ peerBlock })}

echo
echo "Done. Try: ${name} run    (or ${name} doctor for a self-check)."
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
  return `CONFIG_HOME=\${XDG_CONFIG_HOME:-$HOME/.config}
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

INSTALL_WITH_SUDO=0
ensure_bin_root() {
  if [ "$INSTALL_CONTEXT" = "transition" ]; then
    mkdir -p "$BIN_ROOT"
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

if [ "$INSTALL_CONTEXT" = "transition" ]; then
  BIN_ROOT="$DATA_HOME/codex-orchestrator/bin"
else
  BIN_ROOT="$BIN_DIR"
fi

mkdir -p "$(dirname "$CONFIG_PATH")"
ensure_bin_root
BUNDLE_FILE=$(mktemp "\${TMPDIR:-/tmp}/$NAME.config.XXXXXX")
BIN_TMP=$(mktemp "\${TMPDIR:-/tmp}/$NAME.bin.XXXXXX")
cleanup() {
  rm -f "$BUNDLE_FILE" "$BIN_TMP"
}
trap cleanup EXIT INT TERM

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

curl -fsSL \\
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
    "$TARGET_BIN" status || true
    SKIP_DOWNLOAD=1
  fi
fi

if [ "$SKIP_DOWNLOAD" = "0" ]; then
  curl -fsSL \\
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

  "$TARGET_BIN" status || true

  RESOLVED_BIN=$(command -v "$NAME" 2>/dev/null || true)
  if [ -n "$RESOLVED_BIN" ] && [ "$RESOLVED_BIN" != "$TARGET_BIN" ]; then
    echo ">> Note: this shell resolves $NAME to $RESOLVED_BIN, not $TARGET_BIN."
    echo ">> Put $BIN_ROOT earlier in PATH or run directly: $TARGET_BIN run"
  fi
  echo ">> If your shell cached an older $NAME, run: hash -r 2>/dev/null || rehash 2>/dev/null || true"
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
  PEER_BIN_DIR="$(dirname "$TARGET_BIN")"
  mkdir -p "$(dirname "$PEER_CONFIG_PATH")"
  PEER_BUNDLE=$(mktemp "\${TMPDIR:-/tmp}/$PEER_NAME.config.XXXXXX")
  PEER_BIN_TMP=$(mktemp "\${TMPDIR:-/tmp}/$PEER_NAME.bin.XXXXXX")
  peer_cleanup() { rm -f "$PEER_BUNDLE" "$PEER_BIN_TMP"; }
  trap peer_cleanup EXIT INT TERM
  curl -fsSL \\
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
    curl -fsSL \\
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
  "$PEER_TARGET_BIN" --cron run 2>/dev/null || true
)
PEER_EXIT=$?
set -e
if [ "$PEER_EXIT" != "0" ]; then
  echo ">> Warning: peer install of $PEER_NAME failed. Re-run the installer to retry." >&2
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
