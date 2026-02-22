#!/usr/bin/env bash
set -euo pipefail

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Not inside a git worktree." >&2
  exit 1
fi

extract_wrapper_version() {
  sed -n 's/^WRAPPER_VERSION="\([^"]\+\)".*$/\1/p' "$1" | head -n 1
}

extract_wrapper_version_from_stdin() {
  sed -n 's/^WRAPPER_VERSION="\([^"]\+\)".*$/\1/p' | head -n 1
}

base_ref="${WRAPPER_VERSION_BASE_REF:-}"
if [[ -z "$base_ref" ]]; then
  if [[ -n "${GITHUB_BASE_REF:-}" ]]; then
    base_ref="origin/${GITHUB_BASE_REF}"
  elif git rev-parse --verify --quiet HEAD~1 >/dev/null 2>&1; then
    base_ref="HEAD~1"
  else
    base_ref="origin/main"
  fi
fi

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null 2>&1; then
  base_branch="$base_ref"
  case "$base_branch" in
    origin/*) base_branch="${base_branch#origin/}" ;;
  esac
  if [[ "$base_ref" == origin/* ]]; then
    git fetch --no-tags --depth=1 origin "$base_branch" >/dev/null 2>&1 || true
  fi
fi

if ! git rev-parse --verify --quiet "${base_ref}^{commit}" >/dev/null 2>&1; then
  echo "Unable to resolve base ref '$base_ref' for wrapper version comparison." >&2
  exit 1
fi

wrapper_changed=0
if ! git diff --quiet "${base_ref}"...HEAD -- bin/cdx; then
  wrapper_changed=1
fi
if ! git diff --quiet -- bin/cdx; then
  wrapper_changed=1
fi

if (( wrapper_changed == 0 )); then
  echo "Wrapper unchanged versus ${base_ref}; WRAPPER_VERSION bump not required."
  exit 0
fi

current_version="$(extract_wrapper_version "bin/cdx.d/00-prolog.sh")"
if [[ -z "$current_version" ]]; then
  echo "Failed to parse WRAPPER_VERSION from bin/cdx.d/00-prolog.sh." >&2
  exit 1
fi

base_prolog="$(git show "${base_ref}:bin/cdx.d/00-prolog.sh" 2>/dev/null || true)"
if [[ -z "$base_prolog" ]]; then
  echo "Unable to read ${base_ref}:bin/cdx.d/00-prolog.sh for WRAPPER_VERSION check." >&2
  exit 1
fi
base_version="$(printf '%s\n' "$base_prolog" | extract_wrapper_version_from_stdin)"
if [[ -z "$base_version" ]]; then
  echo "Failed to parse WRAPPER_VERSION from ${base_ref}:bin/cdx.d/00-prolog.sh." >&2
  exit 1
fi

if [[ "$current_version" == "$base_version" ]]; then
  cat >&2 <<EOF
Wrapper content changed (bin/cdx differs from ${base_ref}) but WRAPPER_VERSION was not bumped.
Current WRAPPER_VERSION: ${current_version}
Base WRAPPER_VERSION:    ${base_version}
Update WRAPPER_VERSION in bin/cdx.d/00-prolog.sh.
EOF
  exit 1
fi

echo "WRAPPER_VERSION bump verified: ${base_version} -> ${current_version}"
