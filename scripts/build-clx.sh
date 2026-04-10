#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/bin/clx.d"
OUT_FILE="$ROOT_DIR/bin/clx"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "clx source directory not found: $SRC_DIR" >&2
  exit 1
fi

mapfile -t PARTS < <(find "$SRC_DIR" -type f -name '*.sh' -print | LC_ALL=C sort)
if ((${#PARTS[@]} == 0)); then
  echo "No clx fragments found in $SRC_DIR" >&2
  exit 1
fi

tmp_file="${OUT_FILE}.tmp"
: >"$tmp_file"
for part in "${PARTS[@]}"; do
  cat "$part" >>"$tmp_file"
  # Ensure a newline boundary between fragments if the source lacked one.
  if [[ -s "$tmp_file" ]]; then
    last_char="$(tail -c 1 "$tmp_file" 2>/dev/null || true)"
    [[ "$last_char" != $'\n' ]] && printf '\n' >>"$tmp_file"
  fi
done

# Strip trailing blank lines so the assembled file ends with exactly one newline.
perl -pi -0777 -e 's/\n+\z/\n/' "$tmp_file"

chmod +x "$tmp_file"
mv "$tmp_file" "$OUT_FILE"
echo "Built $(realpath --relative-to="$ROOT_DIR" "$OUT_FILE") from ${#PARTS[@]} fragments."
