#!/bin/sh
# Fleet Advisor container: the API provisions this server-owned host itself and
# hands over its credential in /bootstrap/bootstrap.json. Fetch signed configs
# and cxx with it, keep engines current, then run the host daemon in the
# foreground. Everything installed lives in $HOME, which is a volume.
set -eu
export XDG_CONFIG_HOME="$HOME/.config" BIN_DIR="$HOME/.local/bin"
export PATH="$BIN_DIR:$PATH"
cfg="$XDG_CONFIG_HOME/codex-orchestrator"
export CDX_CONFIG_PATH="$cfg/cdx.json" CLX_CONFIG_PATH="$cfg/clx.json" CGX_CONFIG_PATH="$cfg/cgx.json"
bootstrap=/bootstrap/bootstrap.json

until [ -r "$bootstrap" ]; do
  echo "advisor: waiting for $bootstrap (written by the API at boot)" >&2
  sleep 30
done
python3 -I /usr/local/bin/advisor-bootstrap.py "$bootstrap"

# Pinned private engine installs. Cron and systemd do not exist here and are
# not needed: the daemon runs in the foreground. A failed engine install
# leaves that engine unready, which the daemon reports instead of advertising.
"$BIN_DIR/cxx" update || echo "advisor: engine update reported problems; continuing with installed engines" >&2
exec "$BIN_DIR/cxx" daemon run
