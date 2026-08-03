#!/usr/bin/env bash
# Renamed to bin/install.sh, which does everything this did plus provision a
# fresh database, build wrappers without a host Go toolchain, create the first
# owner, and resume after an interruption.
#
# Kept as a shim because this path is in runbooks, READMEs and muscle memory.
# The old flags are gone, not silently ignored: --mtls-* no longer exists at
# all, and the rest were renamed, so forwarding "$@" would fail confusingly.
set -euo pipefail
printf '[setup] bin/setup.sh is now bin/install.sh — running it.\n' >&2
if (( $# )); then
  printf '[setup] Ignoring old-style arguments: %s\n' "$*" >&2
  printf '[setup] Run bin/install.sh --help for the current flags.\n' >&2
fi
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh"
