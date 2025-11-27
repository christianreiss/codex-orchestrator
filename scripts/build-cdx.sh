#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/bin/cdx.d"
OUT_FILE="$ROOT_DIR/bin/cdx"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "cdx source directory not found: $SRC_DIR" >&2
  exit 1
fi

mapfile -t PARTS < <(LC_ALL=C find "$SRC_DIR" -maxdepth 1 -type f -name '*.sh' -print | sort)
if (( ${#PARTS[@]} == 0 )); then
  echo "No cdx fragments found in $SRC_DIR" >&2
  exit 1
fi

tmp_file="${OUT_FILE}.tmp"
: > "$tmp_file"
for part in "${PARTS[@]}"; do
  cat "$part" >> "$tmp_file"
done

chmod +x "$tmp_file"
mv "$tmp_file" "$OUT_FILE"
echo "Built $(realpath --relative-to="$ROOT_DIR" "$OUT_FILE") from ${#PARTS[@]} fragments."
