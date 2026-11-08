#!/usr/bin/env bash
# Compatibility entrypoint; the installer validates current and obsolete flags.
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" "$@"
