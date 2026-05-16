#!/usr/bin/env bash
# Shellcheck / shfmt pass over the scripts/ tree. The wrapper-v2 cutover dropped
# bin/cdx, bin/clx, and the bin/*.d/ fragments, so this no longer scans those.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mapfile -t script_targets < <(find scripts -type f -name '*.sh' -print | LC_ALL=C sort)

if ((${#script_targets[@]} == 0)); then
  echo "No shell targets found."
  exit 0
fi

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck is required for shell linting." >&2
  exit 1
fi

shellcheck -S warning -e SC2034 "${script_targets[@]}"

if ! command -v shfmt >/dev/null 2>&1; then
  if [[ -n "${CI:-}" ]]; then
    echo "shfmt is required in CI for shell formatting checks." >&2
    exit 1
  fi
  echo "shfmt not installed; skipping shell format check outside CI." >&2
  exit 0
fi

shfmt -ln=bash -d -i 2 -ci -bn "${script_targets[@]}"
