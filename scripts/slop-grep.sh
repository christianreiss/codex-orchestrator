#!/usr/bin/env bash
# slop-grep.sh - dependency-free anti-slop check for the admin WebUI (DESIGN.md).
#
# Adopted from the design-guidelines template `templates/slop-grep.sh`
# (slop-detector), translated and extended with the project rules of DESIGN.md
# section 4: raw Tailwind palette steps, arbitrary radii, raw overlay shadows,
# hard-coded font families and raw hex colors in Svelte components.
#
# Usage:  scripts/slop-grep.sh [PATH ...]      (default: frontend/src)
#         cd frontend && npm run slop
# Exit:   0 = no findings, 2 = findings, 3 = incomplete scan (stderr).
# Accept: a line containing "slop-ok: <reason>" is skipped. Use it for a
#         reviewed false positive or a pattern DESIGN.md allows; it never
#         replaces an exception-register entry (DESIGN.md GOV-1).
# Note:   regex has no context. Every finding is a review prompt, not a verdict.

set -u
LC_ALL=C.UTF-8; export LC_ALL

if [ $# -eq 0 ]; then
  set -- "$(cd "$(dirname "$0")/.." && pwd)/frontend/src"
fi

for target in "$@"; do
  if [[ ! -e "$target" || ! -r "$target" || ( -d "$target" && ! -x "$target" ) ]]; then
    printf 'slop-grep: cannot inspect target: %s\n' "$target" >&2
    exit 3
  fi
done
scan_errors=$(mktemp) || exit 3
trap 'rm -f "$scan_errors"' EXIT

includes=(--include='*.ts' --include='*.js' --include='*.html' --include='*.css'
          --include='*.svelte')
# Tests are not UI; their fixtures may hold emoji or raw values on purpose.
excludes=(--exclude-dir=node_modules --exclude-dir=.svelte-kit --exclude-dir=build
          --exclude-dir=dist --exclude-dir=.git --exclude-dir=coverage
          --exclude='*.test.ts' --exclude='*.spec.ts')

palette='slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

# Format: "Label|ERE"
rules=(
  "Raw Tailwind palette step (use a semantic token)|\b(bg|text|border|ring|ring-offset|outline|divide|fill|stroke|from|via|to|decoration|caret|accent|placeholder|shadow)-($palette)-[0-9]{2,3}\b"
  "Purple gradient in CSS|linear-gradient\([^)]*(#7c3aed|#8b5cf6|#6366f1|#a855f7|#4f46e5|purple|violet|indigo)"
  "Gradient text|bg-clip-text[^\"'\`]*text-transparent|text-transparent[^\"'\`]*bg-clip-text|background-clip:[[:space:]]*text"
  "Hard-coded font family (use font-sans/font-mono)|font-family:[[:space:]]*[\"'A-Z]|\bfont-\["
  "Substitute default font|(Space[ +_]Grotesk|Instrument[ +_]Serif|Fraunces)"
  "Arbitrary radius (use rounded/-md/-lg)|\brounded(-[a-z]{1,2})?-\["
  "Raw shadow (overlays use shadow-pop)|\bshadow-(md|lg|xl|2xl)\b|\bshadow-\[|rgba\(0,[[:space:]]*0,[[:space:]]*0,[[:space:]]*0?\.1\)"
  "Glassmorphism|backdrop-blur|backdrop-filter:[[:space:]]*blur"
  "Left accent stripe|border-l-(4|8)[^0-9]|border-left:[[:space:]]*[3-8]px"
  "Glow|box-shadow:[[:space:]]*0[[:space:]]+0[[:space:]]+[0-9]{2,}px"
  "Bounce animation|animate-bounce|cubic-bezier\([^)]*1\.[2-9]"
  "Uppercase eyebrow outside .section-label|uppercase[^\"'\`]*tracking-(wide|wider|widest|\[)|tracking-(wide|wider|widest|\[)[^\"'\`]*uppercase"
  "Rejected cream/terracotta palette|#F4F1EA|#D97757"
  "Placeholder text|[Ll]orem ipsum"
  "Marketing speak|\b(Empower|Unlock|Supercharge|Revolutioni[sz]e|Seamless(ly)?|Elevate your|Unleash)\b"
  "Dead link|href=[\"']#[\"']"
  "Generic button text|>[[:space:]]*(Submit|Get Started|Learn More|Click here)[[:space:]]*<"
  "Arbitrary hex utility (use a token)|(bg|text|border|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]"
)

found=0
report() {
  if [ -n "$2" ]; then
    found=1
    printf '\n[%s]\n%s\n' "$1" "$2" >&2
  fi
}

for entry in "${rules[@]}"; do
  label=${entry%%|*}
  regex=${entry#*|}
  hits=$(grep -rnE "${includes[@]}" "${excludes[@]}" -- "$regex" "$@" 2>>"$scan_errors" | grep -v 'slop-ok' || true)
  report "$label" "$hits"
done

# Raw hex colors in Svelte markup/styles (anchors such as href="#id" are skipped).
hits=$(grep -rnE --include='*.svelte' "${excludes[@]}" -- '(^|[^&[:alnum:]_/-])#[0-9a-fA-F]{3}([0-9a-fA-F]{3}([0-9a-fA-F]{2})?)?\b' "$@" 2>>"$scan_errors" \
  | grep -vE 'href=["'"'"'`]#|slop-ok' || true)
report "Raw hex color in a component (use a token)" "$hits"

# Removed focus outline without a replacement on the same line.
hits=$(grep -rnE "${includes[@]}" "${excludes[@]}" -- 'outline-none|outline:[[:space:]]*(none|0)[[:space:]]*;' "$@" 2>>"$scan_errors" \
  | grep -vE 'focus-visible|focus-within|focus:ring|data-\[(selected|highlighted)|slop-ok' || true)
report "Focus outline removed (add focus-visible: on the same line)" "$hits"

# Emoji in source (needs grep with PCRE support).
if echo | grep -qP '' 2>/dev/null; then
  hits=$(grep -rnP "${includes[@]}" "${excludes[@]}" -- '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' "$@" 2>>"$scan_errors" | grep -v 'slop-ok' || true)
  report "Emoji as icon or status glyph (use Lucide plus a word)" "$hits"
else
  echo "slop-grep: grep without -P; emoji rule skipped." >&2
fi

if [ -s "$scan_errors" ]; then
  printf 'slop-grep: incomplete scan; input or grep errors:\n' >&2
  cat "$scan_errors" >&2
  exit 3
fi

if [ $found -eq 1 ]; then
  printf '\nslop-grep: findings above. Fix them or mark the line with "slop-ok: <reason>".\n' >&2
  exit 2
fi
echo "slop-grep: no findings."
exit 0
