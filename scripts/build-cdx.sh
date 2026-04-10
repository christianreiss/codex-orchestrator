#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC_DIR="$ROOT_DIR/bin/cdx.d"
OUT_FILE="$ROOT_DIR/bin/cdx"

if [[ ! -d "$SRC_DIR" ]]; then
  echo "cdx source directory not found: $SRC_DIR" >&2
  exit 1
fi

mapfile -t PARTS < <(find "$SRC_DIR" -type f -name '*.sh' -print | LC_ALL=C sort)
if ((${#PARTS[@]} == 0)); then
  echo "No cdx fragments found in $SRC_DIR" >&2
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

# ── Also build CLX (Claude wrapper) if fragments exist ────────
CLX_SRC_DIR="$ROOT_DIR/bin/clx.d"
CLX_OUT_FILE="$ROOT_DIR/bin/clx"

if [[ -d "$CLX_SRC_DIR" ]]; then
  mapfile -t CLX_PARTS < <(find "$CLX_SRC_DIR" -type f -name '*.sh' -print | LC_ALL=C sort)
  if ((${#CLX_PARTS[@]} > 0)); then
    clx_tmp="${CLX_OUT_FILE}.tmp"
    : >"$clx_tmp"
    for part in "${CLX_PARTS[@]}"; do
      cat "$part" >>"$clx_tmp"
      if [[ -s "$clx_tmp" ]]; then
        last_char="$(tail -c 1 "$clx_tmp" 2>/dev/null || true)"
        [[ "$last_char" != $'\n' ]] && printf '\n' >>"$clx_tmp"
      fi
    done
    perl -pi -0777 -e 's/\n+\z/\n/' "$clx_tmp"
    chmod +x "$clx_tmp"
    mv "$clx_tmp" "$CLX_OUT_FILE"
    echo "Built $(realpath --relative-to="$ROOT_DIR" "$CLX_OUT_FILE") from ${#CLX_PARTS[@]} fragments."
  fi
fi
