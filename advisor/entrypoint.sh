#!/bin/sh
# Provision once from a one-time installer URL, keep engines current, then run
# the host daemon in the foreground. Everything provisioned lives in $HOME,
# which is a volume, so the installer URL is needed only on first start.
set -eu
export XDG_CONFIG_HOME="$HOME/.config" BIN_DIR="$HOME/.local/bin"
export PATH="$BIN_DIR:$PATH"
cfg="$XDG_CONFIG_HOME/codex-orchestrator"
export CDX_CONFIG_PATH="$cfg/cdx.json" CLX_CONFIG_PATH="$cfg/clx.json" CGX_CONFIG_PATH="$cfg/cgx.json"
cxx="$BIN_DIR/cxx"

if [ ! -x "$cxx" ]; then
  if [ -z "${ADVISOR_INSTALL_URL:-}" ]; then
    echo "advisor: not provisioned. Register this container as a host with a permanent daemon" >&2
    echo "advisor: (username advisor, default_cwd /work) and set ADVISOR_INSTALL_URL to its installer URL." >&2
    # Stay up without a restart loop until an operator provisions it.
    exec sleep infinity
  fi
  setup=$(mktemp)
  # The installer always reports INCOMPLETE here: a container has no crontab
  # or systemd, and needs neither because the daemon is the foreground
  # process. Success is the binary plus a signed config, not its exit code.
  curl -fsSL "$ADVISOR_INSTALL_URL" -o "$setup" && sh "$setup" || true
  rm -f "$setup"
  if [ ! -x "$cxx" ] || ! ls "$cfg"/*.json.sig >/dev/null 2>&1; then
    # The installer URL is single-use: never restart-loop on a spent one.
    echo "advisor: installation failed; fix the cause, mint a fresh installer URL and recreate the container." >&2
    exec sleep infinity
  fi
fi

# Pinned private engine installs; a failure here leaves the engine unready,
# which the daemon reports instead of advertising it.
"$cxx" update || echo "advisor: engine update failed; continuing with installed engines" >&2
exec "$cxx" daemon run
