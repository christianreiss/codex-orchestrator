#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

mapfile -t fragment_targets < <(find bin/cdx.d -type f -name '*.sh' -print | LC_ALL=C sort)
mapfile -t script_targets < <(
  {
    find scripts -type f -name '*.sh' -print
    printf '%s\n' bin/cdx
  } | LC_ALL=C sort
)

if (( ${#fragment_targets[@]} == 0 && ${#script_targets[@]} == 0 )); then
  echo "No shell targets found."
  exit 0
fi

if ! command -v shellcheck >/dev/null 2>&1; then
  echo "shellcheck is required for shell linting." >&2
  exit 1
fi

if (( ${#script_targets[@]} > 0 )); then
  shellcheck -S warning -e SC2034 "${script_targets[@]}"
fi

if (( ${#fragment_targets[@]} > 0 )); then
  shellcheck -S warning -s bash -e SC2034,SC2148,SC2154 "${fragment_targets[@]}"
fi

if ! command -v shfmt >/dev/null 2>&1; then
  if [[ -n "${CI:-}" ]]; then
    echo "shfmt is required in CI for shell formatting checks." >&2
    exit 1
  fi
  echo "shfmt not installed; skipping shell format check outside CI." >&2
  exit 0
fi

if (( ${#script_targets[@]} > 0 )); then
  shfmt -ln=bash -d -i 2 -ci -bn "${script_targets[@]}"
fi

if (( ${#fragment_targets[@]} > 0 )); then
  shfmt -ln=bash -d -i 2 -ci -bn "${fragment_targets[@]}"
fi
