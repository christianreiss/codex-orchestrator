human_join() {
  local items=("$@")
  local count=${#items[@]}
  if (( count == 0 )); then
    printf ''
  elif (( count == 1 )); then
    printf '%s' "${items[0]}"
  elif (( count == 2 )); then
    printf '%s and %s' "${items[0]}" "${items[1]}"
  else
    local last="${items[count-1]}"
    items=("${items[@]:0:count-1}")
    printf '%s, and %s' "$(printf '%s, ' "${items[@]}" | sed 's/, $//')" "$last"
  fi
}

join_with_semicolon() {
  local out=""
  local part
  for part in "$@"; do
    [[ -z "$part" ]] && continue
    if [[ -n "$out" ]]; then
      out+="; "
    fi
    out+="$part"
  done
  printf "%s" "$out"
}

colorize() {
  local text="$1" tone="$2"
  case "$tone" in
    green) printf "%b%s%b" "${GREEN}${BOLD}" "$text" "${RESET}" ;;
    yellow) printf "%b%s%b" "${YELLOW}${BOLD}" "$text" "${RESET}" ;;
    orange) printf "%b%s%b" "${ORANGE}${BOLD}" "$text" "${RESET}" ;;
    red) printf "%b%s%b" "${RED}${BOLD}" "$text" "${RESET}" ;;
    *) printf "%s" "$text" ;;
  esac
}

# Colorize an individual sync/pull status token for display in the doctor report.
# ok → green; offline/concurrent/skip/no-python → yellow; unknown → plain; everything else → red.
colorize_sync_status() {
  local val="$1"
  case "$val" in
    ok) colorize "$val" "green" ;;
    offline|concurrent|skip|no-python) colorize "$val" "yellow" ;;
    unknown) printf "%s" "$val" ;;
    *) colorize "$val" "red" ;;
  esac
}

ROW_LABEL_WIDTH=12
ROW_VALUE_WIDTH=32
QUOTA_BAR_WIDTH=24
QUOTA_METRIC_LABEL_WIDTH=20
SUMMARY_ITEMS_PER_ROW=3
SUMMARY_ITEMS_PER_ROW_QUOTA=1
SUMMARY_ITEMS_PER_ROW_VERSIONS=2
SUMMARY_COLUMN_GAP=4

# Summary formatting (bootup message).
# We render a compact "header + rows" block with a modern look while keeping
# existing content + tone logic. This is intentionally plain bash (no tput
# dependencies beyond what's already used elsewhere).
SUMMARY_GUTTER="  "

summary_divider() {
  # Use an ASCII-only divider if unicode box-drawing isn't desired.
  # (We already emit unicode icons/bars elsewhere; this keeps look consistent.)
  local cols="${COLUMNS:-}"
  if [[ ! "$cols" =~ ^[0-9]+$ ]] && command -v tput >/dev/null 2>&1; then
    cols="$(tput cols 2>/dev/null || true)"
  fi
  if [[ ! "$cols" =~ ^[0-9]+$ ]] || (( cols < 40 )); then
    cols=80
  fi
  local w=$(( cols - 2 ))
  (( w < 20 )) && w=20
  if output_supports_unicode; then
    local line=""
    local si
    for (( si = 0; si < w; si++ )); do line+="─"; done
    printf "%b" "${DIM}${line}${RESET}"
  else
    printf "%b" "${DIM}$(printf '%*s' "$w" '' | tr ' ' '-')${RESET}"
  fi
}

summary_header() {
  local title="$1" tone="${2-}"
  local ts=""
  if command -v date >/dev/null 2>&1; then
    ts="$(date '+%Y-%m-%d %H:%M' 2>/dev/null || true)"
  fi
  local left
  printf -v left "%b%bcdx%b" "${ORANGE}" "${BOLD}" "${RESET}"
  [[ -n "$ts" ]] && left+=" $(printf '%b%s%b' "${DIM}" "$ts" "${RESET}")"
  local right=""
  if [[ -n "$title" ]]; then
    if [[ -n "$tone" ]]; then
      right="$(colorize "$title" "$tone")"
    else
      printf -v right "%b%s%b" "${BOLD}" "$title" "${RESET}"
    fi
  fi
  local dot_sep
  printf -v dot_sep "%b·%b" "${DIM}" "${RESET}"
  # Keep it single-line; row wrapping is handled below.
  if [[ -n "$right" ]]; then
    printf "%s  %s  %s" "$left" "$dot_sep" "$right"
  else
    printf "%s" "$left"
  fi
}

summary_row() {
  local label="$1"; shift
  local text="$*"
  # "Label  · value" reads cleaner than the old aligned colon block.
  printf "%b%s%b%s%s%b" "${DIM}" "$label" "${RESET}" "${SUMMARY_GUTTER}·${SUMMARY_GUTTER}" "$text" "${RESET}"
}

wrap_ansi_text() {
  # Fold long lines to terminal width while preserving ANSI sequences.
  # This is best-effort: we strip ANSI to estimate visible width and break on spaces.
  local text="$1"
  local cols="${COLUMNS:-}"
  if [[ ! "$cols" =~ ^[0-9]+$ ]] && command -v tput >/dev/null 2>&1; then
    cols="$(tput cols 2>/dev/null || true)"
  fi
  if [[ ! "$cols" =~ ^[0-9]+$ ]] || (( cols < 60 )); then
    printf "%s" "$text"
    return
  fi
  local indent="${2-}"
  local max=$(( cols - ${#indent} ))
  (( max < 30 )) && { printf "%s" "$text"; return; }

  # If the line already has a label separator, align wrapped continuation lines
  # under the value column instead of repeating the label gutter.
  local cont_indent="$indent"
  if [[ "$text" == *"${SUMMARY_GUTTER}·${SUMMARY_GUTTER}"* ]]; then
    local prefix="${text%%${SUMMARY_GUTTER}·${SUMMARY_GUTTER}*}"
    local prefix_plain
    prefix_plain="$(strip_ansi_sgr "$prefix")"
    cont_indent="$(printf '%*s' "${#prefix_plain}" '')"
  fi

  local out="" line="" token rest="$text"
  while [[ -n "$rest" ]]; do
    # Split on first space.
    if [[ "$rest" == *" "* ]]; then
      token="${rest%% *}"
      rest="${rest#* }"
    else
      token="$rest"
      rest=""
    fi
    local cand="$line"
    [[ -n "$cand" ]] && cand+=" "
    cand+="$token"
    local cand_plain
    cand_plain="$(strip_ansi_sgr "$cand")"
    if (( ${#cand_plain} > max )) && [[ -n "$line" ]]; then
      if [[ -n "$out" ]]; then out+=$'\n'; fi
      out+="${indent}${line}"
      line="$token"
    else
      line="$cand"
    fi
  done
  if [[ -n "$line" ]]; then
    [[ -n "$out" ]] && out+=$'\n'
    out+="${indent}${line}"
  fi
  # Replace the indent on continuation lines.
  if [[ "$out" == *$'\n'* ]] && [[ -n "$cont_indent" ]]; then
    local first=1 rebuilt="" ln
    while IFS= read -r ln; do
      if (( first )); then
        rebuilt+="$ln"
        first=0
      else
        rebuilt+=$'\n'"${cont_indent}${ln#${indent}}"
      fi
    done <<< "$out"
    out="$rebuilt"
  fi
  printf "%s" "$out"
}

format_status_row() {
  local label="$1" installed="$2" target="$3" status="$4"
  local v1="$installed" v2="$target"
  [[ "$v1" == *" installed" ]] && v1="${v1% installed}"
  [[ "$v2" == *" available" ]] && v2="${v2% available}"
  [[ "$v2" == "n/a" || "$v2" == "unknown" ]] && v2=""
  local ver="$v1"
  if [[ -n "$v2" && "$v2" != "$v1" ]]; then
    ver="${v1} → ${v2}"
  fi
  local msg="$ver"
  [[ -n "$status" ]] && msg="${msg} · ${status}"
  format_simple_row "$label" "$msg"
}

format_simple_row() {
  local label="$1" text="$2"
  if [[ -t 1 ]]; then
    local cols="${COLUMNS:-}"
    if [[ ! "$cols" =~ ^[0-9]+$ ]] && command -v tput >/dev/null 2>&1; then
      cols="$(tput cols 2>/dev/null || true)"
    fi
    if [[ "$cols" =~ ^[0-9]+$ ]]; then
      local max=$(( cols - ROW_LABEL_WIDTH - 5 ))
      if (( max >= 20 )); then
        if [[ "$text" != *$'\033['* ]]; then
          # Plain text: use fold for reliable word-boundary wrapping.
          if (( ${#text} > max )); then
            local first=1 chunk
            while IFS= read -r chunk; do
              if (( first )); then
                printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$chunk"
                first=0
              else
                printf "\n%-${ROW_LABEL_WIDTH}s | %s" "" "$chunk"
              fi
            done <<< "$(fold -s -w "$max" <<< "$text")"
            return
          fi
        else
          # ANSI-colorized text: fold can't count visible width correctly, so
          # measure via strip_ansi_sgr and break on space boundaries instead.
          local plain
          plain="$(strip_ansi_sgr "$text")"
          if (( ${#plain} > max )); then
            local out="" cur_line="" token rest="$text"
            while [[ -n "$rest" ]]; do
              if [[ "$rest" == *" "* ]]; then
                token="${rest%% *}"
                rest="${rest#* }"
              else
                token="$rest"
                rest=""
              fi
              local cand="$cur_line"
              [[ -n "$cand" ]] && cand+=" "
              cand+="$token"
              local cand_plain
              cand_plain="$(strip_ansi_sgr "$cand")"
              if (( ${#cand_plain} > max )) && [[ -n "$cur_line" ]]; then
                if [[ -n "$out" ]]; then
                  printf "\n%-${ROW_LABEL_WIDTH}s | %s" "" "$cur_line"
                else
                  printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$cur_line"
                fi
                out="x"
                cur_line="$token"
              else
                cur_line="$cand"
              fi
            done
            if [[ -n "$cur_line" ]]; then
              if [[ -n "$out" ]]; then
                printf "\n%-${ROW_LABEL_WIDTH}s | %s" "" "$cur_line"
              else
                printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$cur_line"
              fi
            fi
            return
          fi
        fi
      fi
    fi
  fi
  printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$text"
}

format_footer_sync_fragment() {
  local name="$1"
  local result="$2"
  local reason="$3"
  local tone="yellow"
  local state="${result:-unknown}"

  case "$result" in
    ok|uploaded)
      tone="green"
      state="uploaded"
      ;;
    not-needed)
      tone="green"
      state="unchanged"
      ;;
    skipped)
      tone="yellow"
      state="skipped"
      ;;
    failed|error)
      tone="red"
      state="failed"
      ;;
    "")
      tone="yellow"
      state="unknown"
      ;;
  esac

  local dot="●"
  output_supports_unicode || dot="*"
  local text="${name} ${state}"
  case "$result" in
    skipped|failed|error)
      if [[ -n "$reason" ]]; then
        text+=" (${reason})"
      fi
      ;;
  esac
  local dot_colored
  dot_colored="$(colorize "$dot" "$tone")"
  if [[ "$tone" != "green" ]]; then
    text="$(colorize "$text" "$tone")"
  fi
  printf "%s %s" "$dot_colored" "$text"
}

format_run_cost_value() {
  local raw="$1"
  if [[ "$raw" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    # Use 4 decimal places for sub-cent amounts so "$0.0012" shows instead of "$0.00".
    local formatted
    if LC_NUMERIC=C awk -v v="$raw" 'BEGIN { exit !(v < 0.01 && v > -0.01) }' 2>/dev/null; then
      formatted="$(LC_NUMERIC=C printf "%.4f" "$raw")"
    else
      formatted="$(LC_NUMERIC=C printf "%.2f" "$raw")"
    fi
    printf '$%s' "$formatted"
    return
  fi
  printf "%s" "$raw"
}

should_suppress_empty_run_footer() {
  [[ -z "${USAGE_PUSH_SUMMARY:-}" ]] || return 1
  [[ -z "${last_usage_payload:-}" ]] || return 1
  [[ "${USAGE_PUSH_RESULT:-}" == "skipped" ]] || return 1
  [[ "${USAGE_PUSH_REASON:-}" == "no token usage captured" ]]
}

print_run_exit_footer() {
  (( CODEX_COMMAND_STARTED )) || return 0
  if should_suppress_empty_run_footer; then
    return 0
  fi

  local usage_label="Run usage"
  local cost_label="Run cost"
  local run_time_label="Run time"
  local cost_prefix=""
  if output_supports_unicode; then
    cost_prefix="💰 "
  fi
  local sync_label="Sync"

  local usage_text="${USAGE_PUSH_SUMMARY:-}"
  if [[ -z "$usage_text" && -n "$last_usage_payload" ]]; then
    usage_text="$(parse_usage_summary "$last_usage_payload")"
  fi
  if [[ -z "$usage_text" ]]; then
    usage_text="no token usage captured"
  fi
  if [[ "${USAGE_PUSH_RESULT:-}" == "failed" ]]; then
    usage_text="$(colorize "$usage_text" "red")"
  elif [[ "${USAGE_PUSH_RESULT:-}" == "skipped" ]]; then
    usage_text="$(colorize "$usage_text" "yellow")"
  fi

  local cost_text=""
  local cost_reason="${USAGE_PUSH_COST_REASON:-${USAGE_PUSH_REASON:-not available}}"
  if [[ -n "${USAGE_PUSH_COST:-}" ]]; then
    local cost_raw="${USAGE_PUSH_COST}"
    local cost_formatted
    cost_formatted="$(format_run_cost_value "$cost_raw")"
    # Colorize cost by magnitude.
    local cost_tone=""
    if [[ "$cost_raw" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
      if LC_NUMERIC=C awk -v v="$cost_raw" 'BEGIN { exit !(v > 10) }' 2>/dev/null; then
        cost_tone="orange"
      elif LC_NUMERIC=C awk -v v="$cost_raw" 'BEGIN { exit !(v > 2) }' 2>/dev/null; then
        cost_tone="yellow"
      elif LC_NUMERIC=C awk -v v="$cost_raw" 'BEGIN { exit !(v < 0.50) }' 2>/dev/null; then
        cost_tone="green"
      fi
    fi
    if [[ -n "$cost_tone" ]]; then
      cost_text="${cost_prefix}$(colorize "$cost_formatted" "$cost_tone")"
    else
      cost_text="${cost_prefix}${cost_formatted}"
    fi
  else
    cost_text="${cost_prefix}unavailable (${cost_reason})"
    if [[ "${USAGE_PUSH_RESULT:-}" == "failed" ]]; then
      cost_text="$(colorize "$cost_text" "red")"
    else
      cost_text="$(colorize "$cost_text" "yellow")"
    fi
  fi

  local run_time_text=""
  if [[ -n "${CDX_RUN_START_NS:-}" ]]; then
    local run_elapsed_ms
    run_elapsed_ms="$(cdx_elapsed_ms "${CDX_RUN_START_NS}")"
    if [[ "$run_elapsed_ms" =~ ^[0-9]+$ ]]; then
      local run_elapsed_s=$(( run_elapsed_ms / 1000 ))
      local run_time_raw=""
      if (( run_elapsed_s == 0 )); then
        run_time_raw="${run_elapsed_ms}ms"
      elif (( run_elapsed_s < 60 )); then
        run_time_raw="${run_elapsed_s}s"
      else
        run_time_raw="$(format_duration_short "$run_elapsed_s")"
      fi
      # Colorize by duration.
      if (( run_elapsed_s < 60 )); then
        run_time_text="$(colorize "$run_time_raw" "green")"
      elif (( run_elapsed_s > 300 )); then
        run_time_text="$(colorize "$run_time_raw" "yellow")"
      else
        run_time_text="$run_time_raw"
      fi
    fi
  fi

  local usage_sync=""
  local auth_sync=""
  usage_sync="$(format_footer_sync_fragment "usage" "${USAGE_PUSH_RESULT:-}" "${USAGE_PUSH_REASON:-}")"
  auth_sync="$(format_footer_sync_fragment "auth" "${AUTH_PUSH_RESULT:-}" "${AUTH_PUSH_REASON:-}")"
  local sync_text="${usage_sync}  ${auth_sync}"

  log_info "$(summary_divider)"
  log_info "$(summary_header "Run summary")"
  log_info "$(summary_row "$usage_label" "$usage_text")"
  log_info "$(summary_row "$cost_label" "$cost_text")"
  if [[ -n "$run_time_text" ]]; then
    log_info "$(summary_row "$run_time_label" "$run_time_text")"
  fi
  log_info "$(summary_row "$sync_label" "$sync_text")"
  log_info "$(summary_divider)"
}

section_bullet() {
  if output_supports_unicode; then
    printf "•"
  else
    printf "-"
  fi
}

print_section_rows() {
  local label="$1"; shift
  local first=1
  local items_per_row="$SUMMARY_ITEMS_PER_ROW"
  if [[ "$label" == "Quota" ]]; then
    items_per_row="${SUMMARY_ITEMS_PER_ROW_QUOTA:-1}"
  elif [[ "$label" == "Versions" ]]; then
    items_per_row="${SUMMARY_ITEMS_PER_ROW_VERSIONS:-2}"
  fi
  if [[ "${CODEX_SUMMARY_ITEMS_PER_ROW:-}" =~ ^[1-9][0-9]*$ ]]; then
    items_per_row="${CODEX_SUMMARY_ITEMS_PER_ROW}"
  fi
  local label_key
  label_key="$(printf '%s' "$label" | tr '[:lower:]' '[:upper:]' | tr -c '[:alnum:]' '_')"
  local label_items_var="CODEX_SUMMARY_ITEMS_PER_ROW_${label_key}"
  local label_items="${!label_items_var-}"
  if [[ "$label_items" =~ ^[1-9][0-9]*$ ]]; then
    items_per_row="$label_items"
  fi
  if [[ ! "$items_per_row" =~ ^[1-9][0-9]*$ ]]; then
    items_per_row=1
  fi

  local gap_width="${SUMMARY_COLUMN_GAP:-4}"
  if [[ ! "$gap_width" =~ ^[0-9]+$ ]]; then
    gap_width=4
  fi
  local gap
  gap="$(printf '%*s' "$gap_width" "")"

  local section_entries=()
  local line
  for line in "$@"; do
    [[ -z "$line" ]] && continue
    section_entries+=("$line")
  done
  if (( ${#section_entries[@]} == 0 )); then
    return 0
  fi

  local column_widths=()
  local col=0
  for (( col = 0; col < items_per_row; col++ )); do
    column_widths[col]=0
  done

  local entry_index=0
  local entry=""
  local plain=""
  local plain_len=0
  for entry in "${section_entries[@]}"; do
    col=$(( entry_index % items_per_row ))
    plain="$(strip_ansi_sgr "$entry")"
    plain_len=${#plain}
    if (( plain_len > column_widths[col] )); then
      column_widths[col]=$plain_len
    fi
    entry_index=$(( entry_index + 1 ))
  done

  local row_text=""
  local padded_entry=""
  entry_index=0
  for entry in "${section_entries[@]}"; do
    col=$(( entry_index % items_per_row ))
    if (( col > 0 )); then
      row_text+="$gap"
    fi
    padded_entry="$entry"
    plain="$(strip_ansi_sgr "$entry")"
    plain_len=${#plain}
    if (( plain_len < column_widths[col] )); then
      padded_entry+="$(printf '%*s' "$((column_widths[col] - plain_len))" "")"
    fi
    row_text+="$padded_entry"

    entry_index=$(( entry_index + 1 ))
    if (( entry_index % items_per_row == 0 )); then
      if (( first )); then
        log_info "$(format_simple_row "$label" "$row_text")"
        first=0
      else
        log_info "$(format_simple_row "" "$row_text")"
      fi
      row_text=""
    fi
  done

  if [[ -n "$row_text" ]]; then
    if (( first )); then
      log_info "$(format_simple_row "$label" "$row_text")"
    else
      log_info "$(format_simple_row "" "$row_text")"
    fi
  fi
}

compute_row_label_width() {
  local width="$ROW_LABEL_WIDTH"
  local label=""
  local plain=""
  local plain_len=0
  for label in "$@"; do
    [[ -z "$label" ]] && continue
    plain="$(strip_ansi_sgr "$label")"
    plain_len=${#plain}
    if (( plain_len > width )); then
      width=$plain_len
    fi
  done
  printf '%s' "$width"
}

format_quota_row() {
  local label="$1" text="$2" note="$3"
  if [[ -n "$note" ]]; then
    printf "%-${ROW_LABEL_WIDTH}s | %s\n%${ROW_LABEL_WIDTH}s | %s" "$label" "$text" "" "$note"
  else
    printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$text"
  fi
}

join_with_sep() {
  local sep="$1"; shift
  local out="" part
  for part in "$@"; do
    [[ -z "$part" ]] && continue
    if [[ -n "$out" ]]; then
      out+="$sep"
    fi
    out+="$part"
  done
  printf "%s" "$out"
}

output_supports_unicode() {
  (( CODEX_TERM_IS_DUMB )) && return 1
  [[ -t 1 ]] || return 1
  local locale="${LC_ALL:-${LC_CTYPE:-${LANG:-}}}"
  [[ "$locale" =~ [Uu][Tt][Ff]-?8 ]] || return 1
  return 0
}

format_grouped_int() {
  local raw="$1"
  [[ "$raw" =~ ^-?[0-9]+$ ]] || {
    printf "%s" "$raw"
    return
  }
  local sign=""
  if [[ "$raw" == -* ]]; then
    sign="-"
    raw="${raw#-}"
  fi
  local out=""
  local len=${#raw}
  while (( len > 3 )); do
    local chunk_start=$(( len - 3 ))
    out=",${raw:chunk_start:3}${out}"
    raw="${raw:0:chunk_start}"
    len=${#raw}
  done
  printf "%s%s%s" "$sign" "$raw" "$out"
}

status_icon() {
  if output_supports_unicode; then
    case "$1" in
      green) printf "✅" ;;
      yellow) printf "⚠" ;;
      red) printf "⛔" ;;
      *) printf "•" ;;
    esac
  else
    case "$1" in
      green) printf "OK" ;;
      yellow) printf "WARN" ;;
      red) printf "FAIL" ;;
      *) printf "INFO" ;;
    esac
  fi
}

format_core_entry() {
  local name="$1" tone="$2" detail="${3-}" note="${4-}"
  local icon
  icon="$(status_icon "$tone")"
  local text="$name $icon"
  if [[ -n "$detail" ]]; then
    if [[ "$tone" == "green" ]]; then
      text+=" $detail"
    else
      text+=" $(colorize "$detail" "$tone")"
    fi
  elif [[ -n "$note" ]]; then
    text+=" $note"
  fi
  printf "%s" "$text"
}

toml_table_enabled() {
  local path="$1" table="$2"
  [[ -f "$path" ]] || return 2
  local header="[$table]"
  awk -v header="$header" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    BEGIN { in_table=0; found=0; disabled=0 }
    {
      line = trim($0)
      # Match the header exactly or with a trailing inline comment
      # (e.g. `[mcp_servers.cdx] # remark` is valid TOML and must still be matched).
      if (line == header || \
          (substr(line, 1, length(header)) == header && \
           substr(line, length(header)+1) ~ /^[[:space:]]*(#.*)?$/)) \
        { in_table=1; found=1; next }
      if (in_table && line ~ /^\[/) { in_table=0 }
      if (in_table && line ~ /^enabled[[:space:]]*=[[:space:]]*false([[:space:]]*(#.*)?)?$/) { disabled=1 }
    }
    END {
      if (!found) exit 2
      if (disabled) exit 1
      exit 0
    }
  ' "$path"
}

extract_version_token() {
  local display="$1"
  if [[ "$display" =~ ([0-9]+[0-9A-Za-z\.\-\+_]*) ]]; then
    printf "%s" "${BASH_REMATCH[1]}"
  fi
}

format_version_entry() {
  local name="$1" tone="$2" installed="$3" target="$4" status="$5"
  local icon
  icon="$(status_icon "$tone")"
  local ver_inst
  ver_inst="$(extract_version_token "$installed")"
  local ver_target
  ver_target="$(extract_version_token "$target")"
  local text="$name"
  if [[ -n "$ver_inst" ]]; then
    text+=" ${ver_inst}"
  fi
  if [[ -n "$ver_target" && "$ver_target" != "$ver_inst" ]]; then
    text+="→${ver_target}"
  fi
  if [[ "$tone" == "green" && ( -z "$ver_target" || "$ver_target" == "$ver_inst" ) ]]; then
    text+=" ✅"
  else
    text+=" ${icon}"
    if [[ -n "$status" ]]; then
      text+=" $(colorize "$status" "$tone")"
    fi
  fi
  printf "%s" "$text"
}

seconds_since_iso() {
  local iso="$1"
  [[ -z "$iso" ]] && return 1
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 - "$iso" <<'PY'
import datetime, sys
raw = sys.argv[1]
try:
    dt = datetime.datetime.fromisoformat(raw.replace("Z", "+00:00"))
except Exception:  # noqa: BLE001
    sys.exit(1)
now = datetime.datetime.now(datetime.timezone.utc)
delta = now - dt
print(int(delta.total_seconds()))
PY
}

format_duration_short() {
  local seconds="$1"
  [[ "$seconds" =~ ^[0-9]+$ ]] || { printf ""; return; }
  local s=$seconds
  local days=$(( s / 86400 ))
  s=$(( s % 86400 ))
  local hours=$(( s / 3600 ))
  s=$(( s % 3600 ))
  local mins=$(( s / 60 ))
  local parts=()
  (( days > 0 )) && parts+=("${days}d")
  (( hours > 0 )) && parts+=("${hours}h")
  (( mins > 0 )) && parts+=("${mins}m")
  if (( ${#parts[@]} == 0 )); then
    parts=("<1m")
  fi
  printf "%s" "${parts[*]}"
}

format_duration_long() {
  local seconds="$1"
  [[ "$seconds" =~ ^[0-9]+$ ]] || { printf ""; return; }
  local s=$seconds
  local days=$(( s / 86400 ))
  s=$(( s % 86400 ))
  local hours=$(( s / 3600 ))
  s=$(( s % 3600 ))
  local mins=$(( s / 60 ))
  local parts=()
  if (( days == 1 )); then parts+=("1 day")
  elif (( days > 1 )); then parts+=("${days} days"); fi
  if (( hours == 1 )); then parts+=("1 hour")
  elif (( hours > 1 )); then parts+=("${hours} hours"); fi
  if (( ${#parts[@]} == 0 )); then
    if (( mins == 1 )); then parts+=("1 minute")
    elif (( mins > 1 )); then parts+=("${mins} minutes")
    else parts+=("<1 minute"); fi
  fi
  local IFS=", "
  printf "%s" "${parts[*]}"
}

format_relative_iso() {
  local iso="$1"
  local seconds=""
  seconds="$(seconds_since_iso "$iso" 2>/dev/null || true)"
  if [[ -z "$seconds" ]]; then
    return 1
  fi
  if (( seconds < 0 )); then
    seconds=$(( -seconds ))
  fi
  local label
  label="$(format_duration_short "$seconds")"
  if [[ -z "$label" ]]; then
    return 1
  fi
  printf "%s ago" "$label"
}

build_quota_bar() {
  local pct="$1" width="$2"
  (( width < 1 )) && width=24
  (( pct < 0 )) && pct=0
  (( pct > 100 )) && pct=100
  local filled=$(( (pct * width + 50) / 100 ))
  (( filled > width )) && filled=$width
  local fill_color="${GREEN}${BOLD}"
  if (( pct >= 95 )); then
    fill_color="${RED}${BOLD}"
  elif (( pct >= 80 )); then
    fill_color="${ORANGE}${BOLD}"
  fi
  local fill_char
  local empty_char
  if output_supports_unicode; then
    fill_char="${CDX_QUOTA_FILL_CHAR:-█}"
    empty_char="${CDX_QUOTA_EMPTY_CHAR:-░}"
  else
    fill_char="${CDX_QUOTA_FILL_CHAR:-#}"
    empty_char="${CDX_QUOTA_EMPTY_CHAR:--}"
  fi
  local bar=""
  if (( filled > 0 )); then
    local filled_part
    filled_part="$(printf '%*s' "$filled" "")"
    filled_part="${filled_part// /$fill_char}"
    bar+="${fill_color}${filled_part}"
  fi
  local empty_count=$(( width - filled ))
  if (( empty_count > 0 )); then
    local empty_part
    empty_part="$(printf '%*s' "$empty_count" "")"
    empty_part="${empty_part// /$empty_char}"
    bar+="${RESET}${DIM}${empty_part}"
  fi
  bar+="${RESET}"
  printf -v bar "%b" "$bar"
  printf "%s" "$bar"
}

render_quota_line() {
  local used="$1" reset_after="$2" reset_at="$3"
  local width=${QUOTA_BAR_WIDTH:-24}
  local tone="yellow"
  local text="n/a"
  local note=""

  if [[ "$used" =~ ^[0-9]+$ ]]; then
    local pct=$used
    (( pct < 0 )) && pct=0
    (( pct > 100 )) && pct=100
    (( width < 1 )) && width=24
    local bar
    bar="$(build_quota_bar "$pct" "$width")"
    if [[ "$reset_after" =~ ^[0-9]+$ ]]; then
      local dur
      dur=$(format_duration_short "$reset_after")
      [[ -n "$dur" ]] && note="resets in ${dur}"
    elif [[ -n "$reset_at" ]]; then
      note="resets @ ${reset_at}"
    fi

    if (( pct >= 95 )); then
      tone="red"
    elif (( pct >= 80 )); then
      tone="orange"
    else
      tone="green"
    fi

    text=$(printf "%3d%% [%s]" "$pct" "$bar")
  fi

  printf "%s\t%s\t%s" "$tone" "$text" "$note"
}

format_quota_bar_text() {
  local used="$1" reset_after="$2" reset_at="$3"
  local line
  line=$(render_quota_line "$used" "$reset_after" "$reset_at")
  if [[ -z "$line" ]]; then
    return
  fi
  local text
  text="${line#*$'\t'}"
  text="${text%%$'\t'*}"
  printf "%s" "$text"
}

format_quota_metric_row() {
  local label="$1" value="$2"
  local width="${QUOTA_METRIC_LABEL_WIDTH:-20}"
  if [[ ! "$width" =~ ^[0-9]+$ ]] || (( width < 8 )); then
    width=20
  fi
  printf "%-${width}s: %s" "$label" "$value"
}

quota_pct_or_na() {
  local used="$1"
  if [[ "$used" =~ ^[0-9]+$ ]]; then
    printf "%s%%" "$used"
  else
    printf "n/a"
  fi
}

project_quota_usage() {
  local used_pct="$1" limit_seconds="$2" reset_after="$3"
  [[ "$used_pct" =~ ^[0-9]+$ ]] || return
  [[ "$limit_seconds" =~ ^[0-9]+$ ]] || return
  (( limit_seconds > 0 )) || return
  local remaining=0
  if [[ "$reset_after" =~ ^[0-9]+$ ]]; then
    remaining="$reset_after"
  fi
  (( remaining < 0 )) && remaining=0
  local elapsed=$(( limit_seconds - remaining ))
  (( elapsed < 1 )) && return
  (( elapsed > limit_seconds )) && elapsed=limit_seconds
  local projected=$(( (used_pct * limit_seconds + elapsed / 2) / elapsed ))
  (( projected > 999 )) && projected=999
  (( projected > 100 )) && projected=100
  printf "%d" "$projected"
}

project_quota_hit_eta() {
  local used_pct="$1" limit_seconds="$2" reset_after="$3"
  [[ "$used_pct" =~ ^[0-9]+$ ]] || return
  [[ "$limit_seconds" =~ ^[0-9]+$ ]] || return
  [[ "$reset_after" =~ ^[0-9]+$ ]] || return
  (( used_pct > 0 )) || return
  (( limit_seconds > 0 )) || return

  local remaining="$reset_after"
  (( remaining < 0 )) && remaining=0

  local elapsed=$(( limit_seconds - remaining ))
  (( elapsed < 1 )) && return
  (( elapsed > limit_seconds )) && elapsed=limit_seconds

  local projected
  projected="$(project_quota_usage "$used_pct" "$limit_seconds" "$remaining" || true)"
  [[ "$projected" =~ ^[0-9]+$ ]] || return
  (( projected >= 100 )) || return

  local target_elapsed=$(( (100 * elapsed + used_pct - 1) / used_pct ))
  (( target_elapsed <= elapsed )) && target_elapsed=$elapsed

  local eta=$(( target_elapsed - elapsed ))
  (( eta < 0 )) && eta=0
  (( eta < remaining )) || return

  format_duration_long "$eta"
}

format_auth_label() {
  local status="$1" action="$2" msg="$3"
  if (( ! HOST_IS_SECURE )) && [[ "$status" =~ ^(outdated|missing|upload_required)$ ]]; then
    local parts=("status refreshed (insecure host)")
    case "$action" in
      store|retrieve|outdated) parts+=("fetched latest auth") ;;
    esac
    [[ -n "$msg" ]] && parts+=("$msg")
    printf "%s" "$(join_with_semicolon "${parts[@]}")"
    return
  fi
  local parts=()
  case "$status" in
    valid) parts+=("status valid (matches server)") ;;
    outdated) parts+=("status outdated (server newer)") ;;
    missing) parts+=("status missing (upload needed)") ;;
    upload_required) parts+=("status upload required (client newer)") ;;
    *)
      [[ -n "$status" ]] && parts+=("status ${status}")
      ;;
  esac
  case "$action" in
    valid) parts+=("no update needed") ;;
    store) parts+=("stored latest auth on server") ;;
    retrieve) parts+=("pulled latest auth from server") ;;
    *)
      [[ -n "$action" ]] && parts+=("action ${action}")
      ;;
  esac
  [[ -n "$msg" ]] && parts+=("$msg")
  printf "%s" "$(join_with_semicolon "${parts[@]}")"
}

doctor_probe_api_versions() {
  if [[ -z "${CODEX_SYNC_BASE_URL:-}" ]]; then
    printf "fail\tmissing base url"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    printf "skip\tpython3 missing"
    return 2
  fi

  local probe=""
  local rc=0
  probe="$(CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}" python3 - "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_CA_FILE" <<'PY'
import json
import os
import sys
import urllib.request

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

base = (sys.argv[1] or "").rstrip("/")
cafile = sys.argv[2] if len(sys.argv) > 2 else ""
if not base:
    print("missing base url")
    sys.exit(2)

url = f"{base}/versions"
try:
    req = urllib.request.Request(url, method="GET")
except Exception as exc:  # noqa: BLE001
    print(str(exc))
    sys.exit(1)
contexts = cdx_build_ssl_contexts(cafile) if "cdx_build_ssl_contexts" in globals() else [None]
last_error = ""
for ctx in contexts:
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:  # noqa: S310
            code = getattr(resp, "status", 200)
            payload = {}
            try:
                payload = json.load(resp)
            except Exception:
                payload = {}
            wrapper_version = payload.get("wrapper_version") if isinstance(payload, dict) else ""
            if isinstance(wrapper_version, str) and wrapper_version:
                print(f"http {code}; wrapper {wrapper_version}")
            else:
                print(f"http {code}")
            sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        last_error = str(exc)
        continue

print(last_error or "unreachable")
sys.exit(1)
PY
)" || rc=$?

  if (( rc == 0 )); then
    printf "ok\t%s" "$probe"
    return 0
  fi
  if (( rc == 2 )); then
    printf "skip\t%s" "$probe"
    return 2
  fi
  printf "fail\t%s" "${probe:-unreachable}"
  return 1
}

# ── Boot screen helpers (neofetch-style display) ─────────────────────────

format_compact_number() {
  local n="$1"
  [[ "$n" =~ ^[0-9]+$ ]] || { printf "%s" "$n"; return; }
  if (( n >= 10000000 )); then
    printf "%dM" $(( (n + 500000) / 1000000 ))
  elif (( n >= 1000000 )); then
    local m=$(( n / 1000000 ))
    local frac=$(( (n % 1000000 + 50000) / 100000 ))
    if (( frac >= 10 )); then m=$((m + 1)); frac=0; fi
    if (( m >= 10 )); then
      printf "%dM" "$m"
    else
      printf "%d.%dM" "$m" "$frac"
    fi
  elif (( n >= 100000 )); then
    printf "%dK" $(( (n + 500) / 1000 ))
  elif (( n >= 10000 )); then
    local k=$(( n / 1000 ))
    local frac=$(( (n % 1000 + 50) / 100 ))
    if (( frac >= 10 )); then k=$((k + 1)); frac=0; fi
    if (( k >= 100 )); then
      printf "%dK" "$k"
    else
      printf "%d.%dK" "$k" "$frac"
    fi
  else
    printf "%s" "$(format_grouped_int "$n")"
  fi
}

build_health_dot() {
  local name="$1" tone="$2"
  local dot="●"
  output_supports_unicode || dot="*"
  printf "%s %s" "$(colorize "$dot" "$tone")" "$name"
}

print_boot_screen() {
  (( CODEX_SILENT )) && return 0

  local show_banner=1
  (( CODEX_SKIP_MOTD )) && show_banner=0

  # ── Info panel (alongside banner) ──
  if (( show_banner )); then
    local info=()
    local sep_char="─"
    output_supports_unicode || sep_char="-"
    local dot_sep
    printf -v dot_sep "%b·%b" "${DIM}" "${RESET}"

    # L0: empty
    info+=("")

    # L1: title
    local title
    printf -v title "%b%bcodex orchestrator%b" "${ORANGE}" "${BOLD}" "${RESET}"
    info+=("$title")

    # L2: separator
    local sep_line=""
    local si
    for (( si = 0; si < 25; si++ )); do sep_line+="$sep_char"; done
    printf -v sep_line "%b%s%b" "${DIM}" "$sep_line" "${RESET}"
    info+=("$sep_line")

    # L3: codex version
    local cdx_ver="${codex_ver_inst:-${LOCAL_VERSION:-unknown}}"
    local cdx_ver_colored
    cdx_ver_colored="$(colorize "$cdx_ver" "${codex_tone:-green}")"
    local cdx_line="codex    ${cdx_ver_colored}"
    if [[ -n "${codex_version_suffix:-}" ]]; then
      cdx_line+=" $(printf '%b%s%b' "${DIM}" "$codex_version_suffix" "${RESET}")"
    fi
    if [[ -n "${codex_ver_target:-}" && "${codex_ver_target}" != "${cdx_ver}" && "${codex_tone:-green}" != "green" ]]; then
      cdx_line+=" $(printf '%b→%b %s' "${DIM}" "${RESET}" "$(colorize "$codex_ver_target" "yellow")")"
    fi
    info+=("$cdx_line")

    # L4: wrapper version
    local wrap_ver="${wrapper_ver_inst:-${WRAPPER_VERSION:-unknown}}"
    local wrap_ver_colored
    wrap_ver_colored="$(colorize "$wrap_ver" "${wrapper_tone:-green}")"
    local wrap_line="wrapper  ${wrap_ver_colored}"
    if [[ -n "${wrapper_ver_target:-}" && "${wrapper_ver_target}" != "${wrap_ver}" && "${wrapper_tone:-green}" != "green" ]]; then
      wrap_line+=" $(printf '%b→%b %s' "${DIM}" "${RESET}" "$(colorize "$wrapper_ver_target" "yellow")")"
    fi
    info+=("$wrap_line")

    # L5: context line
    local ctx_parts=()
    if (( ! HOST_IS_SECURE )); then
      local lock_icon="🔓"
      output_supports_unicode || lock_icon="[!]"
      ctx_parts+=("$(colorize "${lock_icon} insecure" "yellow")")
    fi
    if (( concurrent_compact_summary )); then
      ctx_parts+=("$(colorize "concurrent run" "yellow")")
    fi
    local lane_name="${CODEX_EFFECTIVE_LANE:-normal}"
    if [[ "$lane_name" == "spark" ]]; then
      local spark_i="⚡"
      output_supports_unicode || spark_i="[S]"
      ctx_parts+=("${spark_i} spark")
    else
      ctx_parts+=("$lane_name")
    fi
    if [[ "${HOST_TOKENS_MONTH_TOTAL:-}" =~ ^[0-9]+$ ]] && (( HOST_TOKENS_MONTH_TOTAL > 0 )); then
      ctx_parts+=("$(format_compact_number "$HOST_TOKENS_MONTH_TOTAL") tokens")
    elif [[ "${HOST_API_CALLS:-}" =~ ^[0-9]+$ ]] && (( HOST_API_CALLS > 0 )); then
      ctx_parts+=("$(format_compact_number "$HOST_API_CALLS") calls")
    fi
    local ctx_line="" cp
    for cp in "${ctx_parts[@]}"; do
      [[ -z "$cp" ]] && continue
      [[ -n "$ctx_line" ]] && ctx_line+=" ${dot_sep} "
      ctx_line+="$cp"
    done
    info+=("$ctx_line")

    print_boot_banner "${info[@]}"
  fi

  # ── Health dots ──
  if (( ! concurrent_compact_summary )); then
    local dots="" dot_gap="  "

    dots+="$(build_health_dot "api" "${api_tone:-yellow}")"
    dots+="${dot_gap}$(build_health_dot "auth" "${auth_tone:-yellow}")"
    dots+="${dot_gap}$(build_health_dot "skills" "${skill_tone:-green}")"

    if [[ -n "${mcp_tone:-}" ]]; then
      dots+="${dot_gap}$(build_health_dot "mcp" "$mcp_tone")"
    fi
    if [[ -n "${runner_label:-}" ]]; then
      dots+="${dot_gap}$(build_health_dot "runner" "${runner_tone:-yellow}")"
    fi

    printf "\n  %s\n" "$dots"
  else
    local conc_note=""
    [[ -n "${concurrent_compact_note:-}" ]] && conc_note="  $(printf '%b%s%b' "${DIM}" "$concurrent_compact_note" "${RESET}")"
    printf "\n  %s%s\n" "$(build_health_dot "concurrent" "${concurrent_compact_tone:-yellow}")" "$conc_note"
  fi

  # ── Compact quota bars ──
  local has_quota=0
  [[ "${CHATGPT_PRIMARY_USED:-}" =~ ^[0-9]+$ ]] && has_quota=1
  [[ "${CHATGPT_SECONDARY_USED:-}" =~ ^[0-9]+$ ]] && has_quota=1

  if (( has_quota )); then
    printf "\n"

    local -a q_labels=() q_used=() q_reset=() q_proj=() q_eta=() q_spark=()
    local active_spark=0
    [[ "${CODEX_EFFECTIVE_LANE:-}" == "spark" ]] && active_spark=1

    if [[ "${CHATGPT_PRIMARY_USED:-}" =~ ^[0-9]+$ ]]; then
      q_labels+=("5h");       q_used+=("$CHATGPT_PRIMARY_USED")
      q_reset+=("${CHATGPT_PRIMARY_RESET_AFTER:-}"); q_proj+=(""); q_eta+=(""); q_spark+=("$active_spark")
    fi
    if [[ "${CHATGPT_SECONDARY_USED:-}" =~ ^[0-9]+$ ]]; then
      q_labels+=("weekly");   q_used+=("$CHATGPT_SECONDARY_USED")
      q_reset+=("${CHATGPT_SECONDARY_RESET_AFTER:-}"); q_proj+=("${projection_pct:-}"); q_eta+=("${projection_eta:-}"); q_spark+=("$active_spark")
    fi
    if [[ "${other_lane_primary_used:-}" =~ ^[0-9]+$ ]]; then
      local ol_s=0; [[ "${other_lane_label:-}" == "Spark" ]] && ol_s=1
      q_labels+=("5h");       q_used+=("$other_lane_primary_used")
      q_reset+=("${other_lane_primary_reset_after:-}"); q_proj+=(""); q_eta+=(""); q_spark+=("$ol_s")
    fi
    if [[ "${other_lane_secondary_used:-}" =~ ^[0-9]+$ ]]; then
      local ol_s=0; [[ "${other_lane_label:-}" == "Spark" ]] && ol_s=1
      q_labels+=("weekly");   q_used+=("$other_lane_secondary_used")
      q_reset+=("${other_lane_secondary_reset_after:-}"); q_proj+=("${other_projection_pct:-}"); q_eta+=("${other_projection_eta:-}"); q_spark+=("$ol_s")
    fi

    # Compute label width for alignment
    local max_lw=6 qi ql_tmp ql_width
    for (( qi = 0; qi < ${#q_labels[@]}; qi++ )); do
      ql_tmp="${q_labels[qi]}"
      (( ${q_spark[qi]} )) && ql_tmp="⚡︎ $ql_tmp"
      ql_width="$(visible_text_width "$ql_tmp")"
      (( ql_width > max_lw )) && max_lw=$ql_width
    done
    (( max_lw > 14 )) && max_lw=14

    local bar_w="${QUOTA_BAR_WIDTH:-24}"
    for (( qi = 0; qi < ${#q_labels[@]}; qi++ )); do
      local prefix=""
      if (( ${q_spark[qi]} )); then
        local spark_ch="⚡︎"
        output_supports_unicode || spark_ch="S"
        prefix="${spark_ch} "
      fi
      local full_label="${prefix}${q_labels[qi]}"

      local pct="${q_used[qi]}"
      (( pct < 0 )) && pct=0; (( pct > 100 )) && pct=100

      local bar
      bar="$(build_quota_bar "$pct" "$bar_w")"

      local pct_tone="green"
      (( pct >= 95 )) && pct_tone="red"
      (( pct >= 80 && pct < 95 )) && pct_tone="orange"
      local pct_display
      printf -v pct_display "%3d%%" "$pct"
      pct_display="$(colorize "$pct_display" "$pct_tone")"

      local dur=""
      [[ "${q_reset[qi]}" =~ ^[0-9]+$ ]] && dur="$(format_duration_short "${q_reset[qi]}")"

      local proj=""
      if [[ "${q_proj[qi]}" =~ ^[0-9]+$ ]] && (( ${q_proj[qi]} > 0 )); then
        if (( ${q_proj[qi]} >= 100 )) && [[ -n "${q_eta[qi]}" ]]; then
          proj="$(colorize "~100% in ~${q_eta[qi]}" "red")"
        elif (( ${q_proj[qi]} >= 100 )); then
          proj="$(colorize "~100%" "red")"
        else
          printf -v proj "%b~%d%%%b" "${DIM}" "${q_proj[qi]}" "${RESET}"
        fi
      fi

      local note=""
      [[ -n "$dur" ]] && note="$dur"
      if [[ -n "$proj" ]]; then
        [[ -n "$note" ]] && note+="  "
        note+="$proj"
      fi

      local padded_label
      padded_label="$(pad_visible_text_right "$full_label" "$max_lw")"
      printf "  %s %s [%s]" "$padded_label" "$pct_display" "$bar"
      [[ -n "$note" ]] && printf "  %s" "$note"
      printf "\n"
    done

    if (( ${QUOTA_WARNING:-0} )) && [[ -n "${QUOTA_WARNING_REASON:-}" ]]; then
      local warn_icon="⚠"
      output_supports_unicode || warn_icon="!"
      printf "  %s\n" "$(colorize "${warn_icon} ${QUOTA_WARNING_REASON}" "yellow")"
    fi
    if (( ${QUOTA_BLOCKED:-0} )) && [[ -n "${QUOTA_BLOCK_REASON:-}" ]]; then
      local block_icon="⛔"
      output_supports_unicode || block_icon="X"
      printf "  %s\n" "$(colorize "${block_icon} ${QUOTA_BLOCK_REASON}" "red")"
    fi
  fi
}
