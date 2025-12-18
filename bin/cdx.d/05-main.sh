
API_RELEASES_URL="https://api.github.com/repos/openai/codex/releases"

SCRIPT_REAL="$(real_path "$0")"
CODEX_REAL_BIN="$(resolve_real_codex)"
if [[ -z "$CODEX_REAL_BIN" ]]; then
  log_error "Unable to find the real Codex binary on PATH"
  exit 1
fi

platform_os="$(uname -s 2>/dev/null || echo unknown)"
platform_arch="$(uname -m 2>/dev/null || echo unknown)"

can_manage_codex=0
if (( IS_ROOT )); then
  can_manage_codex=1
elif (( CAN_SUDO )); then
  can_manage_codex=1
fi

if (( can_manage_codex )) && [[ "$(uname -s)" == "Linux" ]]; then
  ensure_commands curl unzip
fi

LOCAL_VERSION_RAW="$("$CODEX_REAL_BIN" -V 2>/dev/null || true)"
LOCAL_VERSION="$(normalize_version "$LOCAL_VERSION_RAW")"
LOCAL_VERSION_UNKNOWN=0
if [[ -z "$LOCAL_VERSION" ]]; then
  LOCAL_VERSION_UNKNOWN=1
  log_warn "Could not determine local Codex version; attempting to refresh Codex before launch."
fi

# Early auth + versions sync (single POST), captures target versions and hydrates auth if needed.
sync_auth_with_api "pull" || true
sync_slash_commands_pull || true
sync_skills_pull || true
sync_agents_pull || true
sync_config_pull || true
ORIGINAL_LAST_REFRESH="$(get_auth_last_refresh "$HOME/.codex/auth.json")"
LOCAL_AUTH_IS_FRESH=0
if is_last_refresh_recent "$ORIGINAL_LAST_REFRESH" "$MAX_LOCAL_AUTH_AGE_SECONDS"; then
  LOCAL_AUTH_IS_FRESH=1
fi
LOCAL_AUTH_IS_RECENT=0
if is_last_refresh_recent "$ORIGINAL_LAST_REFRESH" "${MAX_LOCAL_AUTH_RECENT_SECONDS:-$MAX_LOCAL_AUTH_AGE_SECONDS}"; then
  LOCAL_AUTH_IS_RECENT=1
fi
HAS_LOCAL_AUTH=0
[[ -f "$HOME/.codex/auth.json" ]] && HAS_LOCAL_AUTH=1

if (( ! CODEX_SKIP_MOTD )) && (( ! CODEX_SILENT )); then
  print_motd
fi

os_name="$(uname -s)"
arch_name="$(uname -m)"
asset_name=""
skip_update_check=0
if (( ! can_manage_codex )); then
  skip_update_check=1
fi
case "$os_name" in
  Linux)
	    case "$arch_name" in
	      x86_64|amd64)
	        asset_name="codex-x86_64-unknown-linux-gnu.tar.gz"
	        glibc_version="$(detect_glibc_version)"
	        if [[ -z "$glibc_version" ]]; then
	          asset_name="codex-x86_64-unknown-linux-musl.tar.gz"
	          if [[ "${CODEX_WRAPPER_RESTARTED:-0}" != "1" ]]; then
	            log_info "Unable to detect glibc version; using musl Codex build for compatibility."
	          fi
	        elif version_lt "$glibc_version" "2.39"; then
	          asset_name="codex-x86_64-unknown-linux-musl.tar.gz"
	          if [[ "${CODEX_WRAPPER_RESTARTED:-0}" != "1" ]]; then
	            log_info "glibc ${glibc_version} detected; using musl Codex build for compatibility."
	          fi
	        fi
	        ;;
      aarch64|arm64)
        asset_name="codex-aarch64-unknown-linux-gnu.tar.gz"
        ;;
      *)
        log_warn "Unsupported Linux architecture (${arch_name}); skipping update check."
        skip_update_check=1
        ;;
    esac
    ;;
  *)
    log_warn "Non-Linux operating system (${os_name}) detected; skipping update check."
    skip_update_check=1
    ;;
esac

remote_version=""
remote_url=""
remote_asset=""
remote_tag=""
remote_source=""
remote_timestamp=0
prefer_npm_update=0
enforce_exact_codex_version=0

if [[ "${SYNC_REMOTE_CLIENT_VERSION_SOURCE:-}" == "locked" ]]; then
  enforce_exact_codex_version=1
fi

if (( ! skip_update_check )); then
  if [[ "$AUTH_PULL_STATUS" == "ok" && -n "$SYNC_REMOTE_CLIENT_VERSION" ]]; then
    remote_version="$(normalize_version "$SYNC_REMOTE_CLIENT_VERSION")"
    remote_tag="$remote_version"
    remote_timestamp="$(date +%s)"
    remote_source="api"
  elif [[ "$AUTH_PULL_STATUS" == "ok" ]]; then
    # API succeeded but no version provided; assume local is target to avoid noisy warnings.
    remote_version="$LOCAL_VERSION"
    remote_tag="$LOCAL_VERSION"
    remote_source="api"
  fi
fi

need_update=0
norm_remote=""
if (( ! skip_update_check )) && [[ -n "$remote_version" ]]; then
  norm_remote="$(normalize_version "$remote_version")"
  if (( LOCAL_VERSION_UNKNOWN )); then
    need_update=1
  else
    norm_local="$(normalize_version "$LOCAL_VERSION")"
    if [[ "$norm_remote" != "$norm_local" ]]; then
      if (( enforce_exact_codex_version )); then
        need_update=1
      elif [[ "$(printf '%s\n%s\n' "$norm_local" "$norm_remote" | sort -V | tail -n1)" == "$norm_remote" ]]; then
        need_update=1
      fi
    fi
  fi
fi

if (( need_update )) && is_codex_installed_via_npm; then
  prefer_npm_update=1
fi

# If an update is needed but we don't yet have a download URL (e.g., version came from the API), fetch release metadata now.
if (( need_update )) && [[ -z "$remote_url" ]] && require_python; then
  tmp_payload="$(mktemp)"
  fetch_success=0
  candidate_tags=()
  add_tag() { local t="$1"; [[ -z "$t" ]] && return; for existing in "${candidate_tags[@]-}"; do [[ "$existing" == "$t" ]] && return; done; candidate_tags+=("$t"); }
  add_tag "$remote_tag"
  add_tag "$remote_version"
  add_tag "v${remote_version}"
  add_tag "rust-${remote_version}"
  add_tag "rust-v${remote_version}"

  for tag_variant in "${candidate_tags[@]}"; do
    if payload_json="$(fetch_release_payload "${API_RELEASES_URL}/tags/${tag_variant}" "$asset_name" 2>/dev/null)"; then
      printf '%s\n' "$payload_json" > "$tmp_payload"
      if mapfile -t fresh_fields < <(read_cached_payload "$tmp_payload"); then
        remote_version="${fresh_fields[0]}"
        remote_url="${fresh_fields[1]}"
        remote_asset="${fresh_fields[2]}"
        remote_timestamp="${fresh_fields[3]}"
        remote_tag="${fresh_fields[4]}"
        fetch_success=1
        break
      fi
    fi
  done
  rm -f "$tmp_payload"
  if (( fetch_success == 0 )); then
    log_warn "Could not fetch release metadata for Codex ${remote_tag}"
  fi
fi

codex_update_attempted=0
codex_updated=0
codex_update_failed=0
codex_status_label=""
codex_status_note=""
codex_target_label=""
codex_installed_label="${LOCAL_VERSION:-unknown}"

if (( skip_update_check )); then
  codex_target_label="${remote_version:-${LOCAL_VERSION:-unknown}}"
  codex_status_label="Check skipped"
  codex_status_note="not permitted to manage Codex (need root)"
elif (( need_update )) && [[ -n "$remote_url" ]]; then
  display_local="${LOCAL_VERSION:-unknown}"
  codex_target_label="$norm_remote"
  codex_update_attempted=1
  if (( prefer_npm_update )) && update_codex_via_npm "$norm_remote"; then
    hash -r
    CODEX_REAL_BIN="$(resolve_real_codex)"
    LOCAL_VERSION_RAW="$("$CODEX_REAL_BIN" -V 2>/dev/null || true)"
    LOCAL_VERSION="$(normalize_version "$LOCAL_VERSION_RAW")"
    LOCAL_VERSION_UNKNOWN=0
    codex_updated=1
    codex_status_label="Updated"
    codex_status_note="npm codex-cli @${norm_remote}"
  elif perform_update "$CODEX_REAL_BIN" "$remote_url" "${remote_asset:-$asset_name}" "$norm_remote"; then
    hash -r
    CODEX_REAL_BIN="$(resolve_real_codex)"
    LOCAL_VERSION_RAW="$("$CODEX_REAL_BIN" -V 2>/dev/null || true)"
    LOCAL_VERSION="$(normalize_version "$LOCAL_VERSION_RAW")"
    LOCAL_VERSION_UNKNOWN=0
    codex_updated=1
    codex_status_label="Updated"
    codex_status_note="from API ${remote_tag:-latest}"
  else
    codex_update_failed=1
    codex_status_label="Update failed"
    codex_status_note="to ${norm_remote}"
    log_warn "Codex update failed (wanted ${norm_remote}, local ${display_local})"
  fi
else
  if [[ -n "$remote_version" ]]; then
    final_label="${remote_tag:-${remote_version}}"
    codex_target_label="$final_label"
    local_norm="$(normalize_version "$LOCAL_VERSION")"
    remote_norm="$(normalize_version "$final_label")"
    if [[ -n "$local_norm" && -n "$remote_norm" && "$local_norm" != "$remote_norm" ]]; then
      codex_status_label="Update available"
    else
      codex_status_label="Current"
    fi
  else
    codex_status_label="API unavailable"
    codex_target_label="n/a"
    codex_update_failed=1
    log_warn "Codex update check unavailable"
  fi
fi

if [[ -z "$codex_status_label" ]]; then
  codex_status_label="Current"
fi
codex_installed_label="${LOCAL_VERSION:-unknown}"

WRAPPER_VERSION_INITIAL="$WRAPPER_VERSION"
wrapper_update_attempted=0
wrapper_updated=0
wrapper_update_failed=0
wrapper_status_label="Current"
wrapper_status_note=""
wrapper_target_label="$WRAPPER_VERSION"

# Wrapper self-update (single latest version only)
wrapper_state="current (${WRAPPER_VERSION})"
target_wrapper=""
target_wrapper_sha=""
target_wrapper_url=""
wrapper_target_label="$WRAPPER_VERSION"

if [[ "$AUTH_PULL_STATUS" == "ok" || "$CODEX_FORCE_WRAPPER_UPDATE" == "1" ]]; then
  target_wrapper="${SYNC_REMOTE_WRAPPER_VERSION:-${WRAPPER_VERSION}}"
  target_wrapper_sha="${SYNC_REMOTE_WRAPPER_SHA256:-}"
  target_wrapper_url="${SYNC_REMOTE_WRAPPER_URL:-}"
  wrapper_target_label="${target_wrapper:-$WRAPPER_VERSION}"

  if [[ -z "$target_wrapper_url" ]] && [[ -n "$CODEX_SYNC_BASE_URL" ]]; then
    target_wrapper_url="${CODEX_SYNC_BASE_URL%/}/wrapper/download"
  fi
  if [[ -n "$target_wrapper_url" && "$target_wrapper_url" != http* ]]; then
    target_wrapper_url="${CODEX_SYNC_BASE_URL%/}${target_wrapper_url}"
  fi

  need_wrapper_update=0
  if [[ -n "$target_wrapper" && "$target_wrapper" != "$WRAPPER_VERSION" ]]; then
    need_wrapper_update=1
  fi
  if (( need_wrapper_update == 0 )) && [[ -n "$target_wrapper_sha" ]]; then
    if current_wrapper_sha="$(sha256sum "$SCRIPT_REAL" 2>/dev/null | awk '{print $1}')" && [[ -n "$current_wrapper_sha" ]]; then
      if [[ "$current_wrapper_sha" != "$target_wrapper_sha" ]]; then
        need_wrapper_update=1
      fi
    fi
  fi
  if (( CODEX_FORCE_WRAPPER_UPDATE )); then
    need_wrapper_update=1
    wrapper_status_note="forced update requested"
  fi

  if (( need_wrapper_update )) && [[ -n "$target_wrapper_url" ]]; then
    wrapper_update_attempted=1
    if [[ -z "$CODEX_SYNC_API_KEY" ]]; then
      log_warn "Wrapper update skipped: API key missing"
      wrapper_update_failed=1
      wrapper_status_label="Update skipped"
      wrapper_status_note="API key missing"
    else
      tmpdir="$(mktemp -d)"
      tmpwrapper="$tmpdir/cdx"
      curl_args=(-fsSL -H "X-API-Key: $CODEX_SYNC_API_KEY")
      if [[ "$CODEX_FORCE_IPV4" == "1" ]]; then
        curl_args+=("-4")
      fi
      if [[ -n "$CODEX_SYNC_CA_FILE" ]]; then
        curl_args+=("--cacert" "$CODEX_SYNC_CA_FILE")
      fi
      case "${CODEX_SYNC_ALLOW_INSECURE,,}" in
        1|true|yes)
          curl_args+=("-k")
          ;;
      esac
      if curl "${curl_args[@]}" "$target_wrapper_url" -o "$tmpwrapper"; then
        dl_sha="$(sha256sum "$tmpwrapper" | awk '{print $1}')"
        if [[ -n "$target_wrapper_sha" && "$dl_sha" != "$target_wrapper_sha" ]]; then
          log_warn "Wrapper update skipped: hash mismatch (expected ${target_wrapper_sha}, got ${dl_sha})"
          wrapper_update_failed=1
          wrapper_status_label="Update skipped"
          wrapper_status_note="hash mismatch"
        else
          chmod +x "$tmpwrapper"
          if [[ -w "$(dirname "$SCRIPT_REAL")" ]]; then
            install -m 755 "$tmpwrapper" "$SCRIPT_REAL"
            WRAPPER_VERSION="$target_wrapper"
            wrapper_state="updated (${WRAPPER_VERSION})"
            wrapper_updated=1
            wrapper_status_label="Updated"
            if [[ "$WRAPPER_VERSION_INITIAL" != "$WRAPPER_VERSION" ]]; then
              wrapper_status_note="${wrapper_status_note:-from ${WRAPPER_VERSION_INITIAL}}"
            fi
          elif (( CAN_SUDO )); then
            if $SUDO_BIN install -m 755 "$tmpwrapper" "$SCRIPT_REAL"; then
              WRAPPER_VERSION="$target_wrapper"
              wrapper_state="updated (${WRAPPER_VERSION})"
              wrapper_updated=1
              wrapper_status_label="Updated"
              if [[ "$WRAPPER_VERSION_INITIAL" != "$WRAPPER_VERSION" ]]; then
                wrapper_status_note="${wrapper_status_note:-from ${WRAPPER_VERSION_INITIAL}}"
              fi
            else
              log_warn "Wrapper update failed: sudo install denied"
              wrapper_update_failed=1
              wrapper_status_label="Update failed"
              wrapper_status_note="sudo install denied"
            fi
          else
            log_warn "Wrapper update skipped: insufficient permissions to write $(dirname "$SCRIPT_REAL")"
            wrapper_update_failed=1
            wrapper_status_label="Update skipped"
            wrapper_status_note="no permission"
          fi
        fi
      else
        log_warn "Wrapper update failed: download error"
        wrapper_update_failed=1
        wrapper_status_label="Update failed"
        wrapper_status_note="download error"
      fi
      rm -rf "$tmpdir"
    fi
  elif (( need_wrapper_update )) && [[ -z "$target_wrapper_url" ]]; then
    log_warn "Wrapper update skipped: API did not provide download URL"
    wrapper_update_failed=1
    wrapper_status_label="Update skipped"
    wrapper_status_note="missing download URL"
  fi
fi

if (( CODEX_EXIT_AFTER_UPDATE )); then
  if (( wrapper_updated )); then
    log_info "Wrapper update completed (version ${WRAPPER_VERSION})."
    exit 0
  fi
  if (( wrapper_update_failed )); then
    log_error "Wrapper update failed (${wrapper_status_note:-unknown})."
    exit 1
  fi
  log_warn "Wrapper update not attempted (status ${wrapper_status_label})."
  exit 1
fi

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

ROW_LABEL_WIDTH=12
ROW_VALUE_WIDTH=32
QUOTA_BAR_WIDTH=24

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
  if [[ -t 1 && "$text" != *$'\033['* ]]; then
    local cols="${COLUMNS:-}"
    if [[ ! "$cols" =~ ^[0-9]+$ ]] && command -v tput >/dev/null 2>&1; then
      cols="$(tput cols 2>/dev/null || true)"
    fi
    if [[ "$cols" =~ ^[0-9]+$ ]]; then
      local max=$(( cols - ROW_LABEL_WIDTH - 5 ))
      if (( max >= 20 )) && (( ${#text} > max )); then
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
    fi
  fi
  printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$text"
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

status_icon() {
  case "$1" in
    green) printf "✅" ;;
    yellow) printf "⚠" ;;
    red) printf "⛔" ;;
    *) printf "•" ;;
  esac
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
      if (line == header) { in_table=1; found=1; next }
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
  local fill_char="${CDX_QUOTA_FILL_CHAR:-█}"
  local empty_char="${CDX_QUOTA_EMPTY_CHAR:-░}"
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

codex_target_label="${codex_target_label:-${remote_tag:-${remote_version:-${LOCAL_VERSION:-unknown}}}}"
wrapper_target_label="${wrapper_target_label:-${WRAPPER_VERSION}}"
wrapper_installed_label="${WRAPPER_VERSION:-unknown}"
codex_installed_label="${codex_installed_label:-${LOCAL_VERSION:-unknown}}"

codex_status_display="$codex_status_label"
if [[ -n "$codex_status_note" ]]; then
  codex_status_display="${codex_status_display} (${codex_status_note})"
fi
wrapper_status_display="$wrapper_status_label"
if [[ -n "$wrapper_status_note" ]]; then
  wrapper_status_display="${wrapper_status_display} (${wrapper_status_note})"
fi

codex_installed_display="$codex_installed_label"
if [[ -n "$codex_installed_display" ]]; then
  codex_installed_display+=" installed"
fi
codex_target_display="$codex_target_label"
if [[ -n "$codex_target_display" && "$codex_target_display" != "n/a" && "$codex_target_display" != "unknown" ]]; then
  codex_target_display+=" available"
fi
wrapper_installed_display="$wrapper_installed_label"
if [[ -n "$wrapper_installed_display" ]]; then
  wrapper_installed_display+=" installed"
fi
wrapper_target_display="$wrapper_target_label"
if [[ -n "$wrapper_target_display" && "$wrapper_target_display" != "n/a" && "$wrapper_target_display" != "unknown" ]]; then
  wrapper_target_display+=" available"
fi

api_label="Unavailable"
api_tone="red"
case "$AUTH_PULL_STATUS" in
  ok)
    api_label="Up and working"
    api_tone="green"
    ;;
  offline)
    api_label="Unavailable (offline"
    if [[ -n "$AUTH_PULL_REASON" ]]; then
      api_label+="; ${AUTH_PULL_REASON}"
    fi
    api_label+=")"
    api_tone="yellow"
    ;;
  disabled)
    api_label="API disabled"
    api_tone="red"
    ;;
  invalid)
    api_label="Invalid API key"
    api_tone="red"
    ;;
  missing-config)
    api_label="Missing API config"
    api_tone="red"
    ;;
  insecure)
    api_label="Insecure host blocked"
    api_tone="red"
    ;;
esac

auth_label="n/a"
if [[ -n "$AUTH_STATUS" ]]; then
  auth_label="$(format_auth_label "$AUTH_STATUS" "$AUTH_ACTION" "$AUTH_MESSAGE")"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  cached_lr="${ORIGINAL_LAST_REFRESH:-unknown}"
  offline_hint=""
  [[ -n "$AUTH_PULL_REASON" ]] && offline_hint="; ${AUTH_PULL_REASON}"
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    auth_label="using cached auth (api offline${offline_hint}; last_refresh ${cached_lr})"
  elif (( HAS_LOCAL_AUTH )) && (( HOST_IS_SECURE )) && (( LOCAL_AUTH_IS_RECENT )); then
    auth_label="using cached auth (secure host; api offline${offline_hint}; last_refresh ${cached_lr})"
  elif (( HAS_LOCAL_AUTH )); then
    auth_label="cached auth stale (api offline${offline_hint}; last_refresh ${cached_lr})"
  else
    auth_label="auth unavailable (api offline${offline_hint})"
  fi
elif [[ "$AUTH_PULL_STATUS" == "insecure" ]]; then
  auth_label="insecure host window closed"
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_label="auth sync failed"
fi

auth_tone="yellow"
case "$AUTH_STATUS" in
  valid|"")
    [[ "$AUTH_PULL_STATUS" == "ok" ]] && auth_tone="green"
    ;;
  outdated|missing|upload_required)
    if (( HOST_IS_SECURE )); then
      auth_tone="yellow"
    else
      auth_tone="green"
    fi
    ;;
  *)
    auth_tone="yellow"
    ;;
esac
if [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT) )); then
    auth_tone="yellow"
  else
    auth_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_tone="red"
fi

runner_label=""
runner_tone="yellow"
runner_enabled_flag=0
[[ "$RUNNER_ENABLED" == "1" ]] && runner_enabled_flag=1
if (( runner_enabled_flag )) || [[ -n "$RUNNER_STATE$RUNNER_LAST_OK$RUNNER_LAST_FAIL" ]]; then
  state="${RUNNER_STATE,,}"
  last_ok_rel="$(format_relative_iso "$RUNNER_LAST_OK" 2>/dev/null || true)"
  last_fail_rel="$(format_relative_iso "$RUNNER_LAST_FAIL" 2>/dev/null || true)"
  if (( runner_enabled_flag )); then
    if [[ "$state" == "fail" ]]; then
      runner_tone="red"
      runner_label="runner failing"
      if [[ -n "$last_fail_rel" ]]; then
        runner_label+=" (${last_fail_rel})"
      fi
      if [[ -n "$last_ok_rel" ]]; then
        runner_label+="; last ok ${last_ok_rel}"
      fi
    else
      runner_tone="green"
      if [[ -n "$last_ok_rel" ]]; then
        age_seconds="$(seconds_since_iso "$RUNNER_LAST_OK" 2>/dev/null || true)"
        if [[ "$age_seconds" =~ ^-?[0-9]+$ ]]; then
          (( age_seconds < 0 )) && age_seconds=$(( -age_seconds ))
          if (( age_seconds <= 90 )); then
            runner_label="runner verified recently"
          else
            runner_label="runner verified ${last_ok_rel}"
          fi
          if (( age_seconds >= RUNNER_STALE_CRIT_SECONDS )); then
            runner_tone="red"
            runner_label+=" (stale)"
          elif (( age_seconds >= RUNNER_STALE_WARN_SECONDS )); then
            runner_tone="yellow"
            runner_label+=" (stale)"
          fi
        else
          runner_label="runner verified ${last_ok_rel}"
        fi
      else
        runner_tone="yellow"
        runner_label="runner enabled; no successful verification yet"
        if [[ -n "$last_fail_rel" ]]; then
          runner_label+=" (last fail ${last_fail_rel})"
        fi
      fi
    fi
  else
    runner_label="runner disabled"
  fi
fi

prompt_label="sync skipped"
prompt_tone="yellow"
if [[ "$PROMPT_SYNC_STATUS" == "ok" ]]; then
  prompt_label="synced"
  counts=()
  if [[ "$PROMPT_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("local ${PROMPT_LOCAL_COUNT}")
  fi
  if [[ "$PROMPT_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("remote ${PROMPT_REMOTE_COUNT}")
  fi
  if (( ${#counts[@]} )); then
    prompt_label+=" ($(join_with_semicolon "${counts[@]}"))"
  fi
  if [[ "$PROMPT_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( PROMPT_PULL_UPDATED > 0 )); then
    prompt_label+=" (${PROMPT_PULL_UPDATED} updated)"
  fi
  if [[ "$PROMPT_REMOVED" =~ ^[0-9]+$ ]] && (( PROMPT_REMOVED > 0 )); then
    prompt_label+=" (${PROMPT_REMOVED} removed)"
  fi
  if [[ "$PROMPT_PULL_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PULL_ERRORS > 0 )); then
    prompt_label+=" (${PROMPT_PULL_ERRORS} fetch errors)"
    prompt_tone="yellow"
  else
    prompt_tone="green"
  fi
elif [[ "$PROMPT_SYNC_STATUS" == "missing-config" ]]; then
  prompt_label="sync config missing"
  prompt_tone="red"
elif [[ "$PROMPT_SYNC_STATUS" == "no-python" ]]; then
  prompt_label="sync requires python3"
  prompt_tone="yellow"
elif [[ "$PROMPT_SYNC_STATUS" == "offline" ]]; then
  prompt_label="sync unavailable"
  if [[ -n "$PROMPT_SYNC_REASON" ]]; then
    prompt_label+=" (${PROMPT_SYNC_REASON})"
  fi
  prompt_tone="yellow"
elif [[ "$PROMPT_SYNC_STATUS" == "error" ]]; then
  prompt_label="sync failed"
  prompt_tone="red"
fi

skill_label="skills sync skipped"
skill_tone="yellow"
if [[ "$SKILL_SYNC_STATUS" == "ok" ]]; then
  skill_label="skills synced"
  counts=()
  if [[ "$SKILL_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("local ${SKILL_LOCAL_COUNT}")
  fi
  if [[ "$SKILL_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("remote ${SKILL_REMOTE_COUNT}")
  fi
  if (( ${#counts[@]} )); then
    skill_label+=" ($(join_with_semicolon "${counts[@]}"))"
  fi
  if [[ "$SKILL_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( SKILL_PULL_UPDATED > 0 )); then
    skill_label+=" (${SKILL_PULL_UPDATED} updated)"
  fi
  if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && (( SKILL_REMOVED > 0 )); then
    skill_label+=" (${SKILL_REMOVED} removed)"
  fi
  if [[ "$SKILL_PULL_ERRORS" =~ ^[0-9]+$ ]] && (( SKILL_PULL_ERRORS > 0 )); then
    skill_label+=" (${SKILL_PULL_ERRORS} fetch errors)"
    skill_tone="yellow"
  else
    skill_tone="green"
  fi
elif [[ "$SKILL_SYNC_STATUS" == "missing-config" ]]; then
  skill_label="sync config missing"
  skill_tone="red"
elif [[ "$SKILL_SYNC_STATUS" == "no-python" ]]; then
  skill_label="sync requires python3"
  skill_tone="yellow"
elif [[ "$SKILL_SYNC_STATUS" == "offline" ]]; then
  skill_label="sync unavailable"
  if [[ -n "$SKILL_SYNC_REASON" ]]; then
    skill_label+=" (${SKILL_SYNC_REASON})"
  fi
  skill_tone="yellow"
elif [[ "$SKILL_SYNC_STATUS" == "error" ]]; then
  skill_label="sync failed"
  skill_tone="red"
fi

agents_label="AGENTS sync skipped"
agents_tone="yellow"
if [[ "$AGENTS_SYNC_STATUS" == "ok" ]]; then
  case "$AGENTS_STATE" in
    updated)
      agents_label="AGENTS updated"
      agents_tone="green"
      ;;
    unchanged)
      agents_label="AGENTS current"
      agents_tone="green"
      ;;
    missing)
      agents_label="AGENTS cleared"
      agents_tone="yellow"
      ;;
    *)
      agents_label="AGENTS synced"
      agents_tone="green"
      ;;
  esac
elif [[ "$AGENTS_SYNC_STATUS" == "missing-config" ]]; then
  agents_label="AGENTS sync config missing"
  agents_tone="red"
elif [[ "$AGENTS_SYNC_STATUS" == "no-python" ]]; then
  agents_label="AGENTS sync requires python3"
  agents_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "offline" ]]; then
  agents_label="AGENTS sync unavailable"
  if [[ -n "$AGENTS_SYNC_REASON" ]]; then
    agents_label+=" (${AGENTS_SYNC_REASON})"
  fi
  agents_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  agents_label="AGENTS sync failed"
  agents_tone="red"
fi

config_label="config sync skipped"
config_tone="yellow"
if [[ "$CONFIG_SYNC_STATUS" == "ok" ]]; then
  case "$CONFIG_STATE" in
    updated)
      config_label="config updated"
      config_tone="green"
      ;;
    unchanged)
      config_label="config current"
      config_tone="green"
      ;;
    missing)
      config_label="config cleared"
      config_tone="yellow"
      ;;
    *)
      config_label="config synced"
      config_tone="green"
      ;;
  esac
elif [[ "$CONFIG_SYNC_STATUS" == "missing-config" ]]; then
  config_label="config sync config missing"
  config_tone="red"
elif [[ "$CONFIG_SYNC_STATUS" == "no-python" ]]; then
  config_label="config sync requires python3"
  config_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "offline" ]]; then
  config_label="config sync unavailable"
  if [[ -n "$CONFIG_SYNC_REASON" ]]; then
    config_label+=" (${CONFIG_SYNC_REASON})"
  fi
  config_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  config_label="config sync failed"
  config_tone="red"
fi

case "$PROMPT_PUSH_STATUS" in
  ok)
    if [[ "$PROMPT_PUSHED" =~ ^[0-9]+$ ]] && (( PROMPT_PUSHED > 0 )); then
      prompt_label+="; pushed ${PROMPT_PUSHED}"
    fi
    if [[ "$PROMPT_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PUSH_ERRORS > 0 )); then
      prompt_label+="; push errors ${PROMPT_PUSH_ERRORS}"
      prompt_tone="yellow"
    fi
    ;;
  no-baseline)
    prompt_label+="; push skipped (no baseline)"
    ;;
  no-python)
    prompt_label+="; push skipped (python missing)"
    ;;
  missing-config)
    prompt_label+="; push skipped (config missing)"
    prompt_tone="red"
    ;;
  error)
    prompt_label+="; push failed"
    prompt_tone="red"
    ;;
esac

case "$SKILL_PUSH_STATUS" in
  ok)
    if [[ "$SKILL_PUSHED" =~ ^[0-9]+$ ]] && (( SKILL_PUSHED > 0 )); then
      skill_label+="; pushed ${SKILL_PUSHED}"
    fi
    if [[ "$SKILL_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( SKILL_PUSH_ERRORS > 0 )); then
      skill_label+="; push errors ${SKILL_PUSH_ERRORS}"
      skill_tone="yellow"
    fi
    ;;
  no-baseline)
    skill_label+="; push skipped (no baseline)"
    ;;
  no-python)
    skill_label+="; push skipped (python missing)"
    ;;
  missing-config)
    skill_label+="; push skipped (config missing)"
    skill_tone="red"
    ;;
  error)
    skill_label+="; push failed"
    skill_tone="red"
    ;;
esac

command_actions=()
if (( codex_update_attempted )); then command_actions+=("codex"); fi
if (( wrapper_update_attempted )); then command_actions+=("wrapper"); fi
should_flag_auth=1
if (( ! HOST_IS_SECURE )) && [[ "$AUTH_PULL_STATUS" == "ok" ]] && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  should_flag_auth=0
fi
if (( should_flag_auth )) && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ || "$AUTH_ACTION" == "store" ]]; then command_actions+=("auth"); fi
command_label="launching codex"
if (( ${#command_actions[@]} )); then
  command_label="updating $(human_join "${command_actions[@]}")"
fi

result_parts=()
if (( codex_updated )); then
  result_parts+=("codex updated")
elif (( codex_update_failed )); then
  result_parts+=("codex update failed")
else
  result_parts+=("codex ${codex_status_label,,}")
fi
if (( wrapper_updated )); then
  result_parts+=("wrapper updated")
elif (( wrapper_update_failed )); then
  result_parts+=("wrapper update failed")
else
  result_parts+=("wrapper ${wrapper_status_label,,}")
fi
if [[ -n "$AUTH_STATUS" ]]; then
  if (( ! HOST_IS_SECURE )) && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
    auth_result="auth refreshed (insecure host)"
    if [[ -n "$AUTH_MESSAGE" ]]; then
      auth_result+=", ${AUTH_MESSAGE}"
    fi
  else
    auth_result="auth ${AUTH_STATUS}"
    if [[ -n "$AUTH_ACTION" ]]; then
      auth_result+=", ${AUTH_ACTION}"
    fi
  fi
  result_parts+=("$auth_result")
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  offline_note="api offline"
  [[ -n "$AUTH_PULL_REASON" ]] && offline_note+="; ${AUTH_PULL_REASON}"
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    result_parts+=("auth cached (${offline_note})")
  elif (( HAS_LOCAL_AUTH )) && (( HOST_IS_SECURE )) && (( LOCAL_AUTH_IS_RECENT )); then
    result_parts+=("auth cached (secure host; ${offline_note})")
  elif (( HAS_LOCAL_AUTH )); then
    result_parts+=("auth stale (${offline_note})")
  else
    result_parts+=("auth unavailable (${offline_note})")
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  result_parts+=("auth unavailable")
fi
if [[ "$PROMPT_SYNC_STATUS" == "ok" ]]; then
  prompt_result="prompts synced"
  if [[ "$PROMPT_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    prompt_result+=" (local ${PROMPT_LOCAL_COUNT}"
    if [[ "$PROMPT_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
      prompt_result+=", remote ${PROMPT_REMOTE_COUNT}"
    fi
    prompt_result+=")"
  fi
  if [[ "$PROMPT_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( PROMPT_PULL_UPDATED > 0 )); then
    prompt_result+=" (${PROMPT_PULL_UPDATED} updated)"
  fi
  if [[ "$PROMPT_PUSHED" =~ ^[0-9]+$ ]] && (( PROMPT_PUSHED > 0 )); then
    prompt_result+="; pushed ${PROMPT_PUSHED}"
  fi
  if [[ "$PROMPT_REMOVED" =~ ^[0-9]+$ ]] && (( PROMPT_REMOVED > 0 )); then
    prompt_result+="; removed ${PROMPT_REMOVED}"
  fi
  if [[ "$PROMPT_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PUSH_ERRORS > 0 )); then
    prompt_result+="; push errors ${PROMPT_PUSH_ERRORS}"
  fi
  result_parts+=("$prompt_result")
elif [[ "$PROMPT_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("prompts config missing")
elif [[ "$PROMPT_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("prompts python missing")
elif [[ "$PROMPT_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$PROMPT_SYNC_REASON" ]]; then
    result_parts+=("prompts offline (${PROMPT_SYNC_REASON})")
  else
    result_parts+=("prompts offline")
  fi
elif [[ "$PROMPT_SYNC_STATUS" == "error" ]]; then
  result_parts+=("prompts sync failed")
fi
if [[ "$PROMPT_PUSH_STATUS" == "error" ]]; then
  result_parts+=("prompts push failed")
fi
if [[ "$SKILL_SYNC_STATUS" == "ok" ]]; then
  skill_result="skills synced"
  if [[ "$SKILL_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    skill_result+=" (local ${SKILL_LOCAL_COUNT}"
    if [[ "$SKILL_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
      skill_result+=", remote ${SKILL_REMOTE_COUNT}"
    fi
    skill_result+=")"
  fi
  if [[ "$SKILL_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( SKILL_PULL_UPDATED > 0 )); then
    skill_result+=" (${SKILL_PULL_UPDATED} updated)"
  fi
  if [[ "$SKILL_PUSHED" =~ ^[0-9]+$ ]] && (( SKILL_PUSHED > 0 )); then
    skill_result+="; pushed ${SKILL_PUSHED}"
  fi
  if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && (( SKILL_REMOVED > 0 )); then
    skill_result+="; removed ${SKILL_REMOVED}"
  fi
  if [[ "$SKILL_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( SKILL_PUSH_ERRORS > 0 )); then
    skill_result+="; push errors ${SKILL_PUSH_ERRORS}"
  fi
  result_parts+=("$skill_result")
elif [[ "$SKILL_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("skills config missing")
elif [[ "$SKILL_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("skills python missing")
elif [[ "$SKILL_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$SKILL_SYNC_REASON" ]]; then
    result_parts+=("skills offline (${SKILL_SYNC_REASON})")
  else
    result_parts+=("skills offline")
  fi
elif [[ "$SKILL_SYNC_STATUS" == "error" ]]; then
  result_parts+=("skills sync failed")
fi
if [[ "$SKILL_PUSH_STATUS" == "error" ]]; then
  result_parts+=("skills push failed")
fi
if [[ "$AGENTS_SYNC_STATUS" == "ok" ]]; then
  case "$AGENTS_STATE" in
    updated)
      result_parts+=("AGENTS.md updated")
      ;;
    unchanged)
      result_parts+=("AGENTS.md current")
      ;;
    missing)
      result_parts+=("AGENTS.md cleared")
      ;;
    *)
      result_parts+=("AGENTS.md synced")
      ;;
  esac
elif [[ "$AGENTS_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("AGENTS.md config missing")
elif [[ "$AGENTS_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("AGENTS.md python missing")
elif [[ "$AGENTS_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$AGENTS_SYNC_REASON" ]]; then
    result_parts+=("AGENTS.md offline (${AGENTS_SYNC_REASON})")
  else
    result_parts+=("AGENTS.md offline")
  fi
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  result_parts+=("AGENTS.md sync failed")
fi
if [[ "$CONFIG_SYNC_STATUS" == "ok" ]]; then
  case "$CONFIG_STATE" in
    updated)
      result_parts+=("config.toml updated")
      ;;
    unchanged)
      result_parts+=("config.toml current")
      ;;
    missing)
      result_parts+=("config.toml cleared")
      ;;
    *)
      result_parts+=("config.toml synced")
      ;;
  esac
elif [[ "$CONFIG_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("config.toml config missing")
elif [[ "$CONFIG_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("config.toml python missing")
elif [[ "$CONFIG_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$CONFIG_SYNC_REASON" ]]; then
    result_parts+=("config.toml offline (${CONFIG_SYNC_REASON})")
  else
    result_parts+=("config.toml offline")
  fi
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  result_parts+=("config.toml sync failed")
fi
if (( QUOTA_BLOCKED )); then
  result_parts+=("${QUOTA_BLOCK_REASON:-quota reached}")
fi
result_label="$(human_join "${result_parts[@]}")"

  usage_summary=""
  if [[ -n "$last_usage_payload" ]]; then
    usage_summary="$(parse_usage_summary "$last_usage_payload")"
  fi

  codex_tone="green"
  case "${codex_status_label,,}" in
    update\ available|check\ skipped|update\ skipped)
      codex_tone="yellow"
      ;;
  update\ failed|api\ unavailable)
    codex_tone="red"
    ;;
esac
(( codex_update_failed )) && codex_tone="red"

wrapper_tone="green"
case "${wrapper_status_label,,}" in
  update\ available|update\ skipped|check\ skipped)
    wrapper_tone="yellow"
    ;;
  update\ failed)
    wrapper_tone="red"
    ;;
esac
(( wrapper_update_failed )) && wrapper_tone="red"

result_tone="green"
if (( codex_update_failed )) || (( wrapper_update_failed )) || { [[ "$AUTH_PULL_STATUS" != "ok" ]] && [[ "$AUTH_PULL_STATUS" != "offline" ]]; }; then
  result_tone="red"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT) )); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  result_tone="yellow"
elif [[ "${codex_status_label,,}" == "update available" ]] || [[ "${wrapper_status_label,,}" == "update available" ]]; then
  result_tone="yellow"
elif [[ "$PROMPT_SYNC_STATUS" == "error" || "$PROMPT_PUSH_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$PROMPT_SYNC_STATUS" != "ok" && "$PROMPT_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif [[ "$PROMPT_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PUSH_ERRORS > 0 )); then
  result_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$AGENTS_SYNC_STATUS" != "ok" && "$AGENTS_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$CONFIG_SYNC_STATUS" != "ok" && "$CONFIG_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif (( QUOTA_WARNING )); then
  result_tone="yellow"
elif (( QUOTA_BLOCKED )); then
  result_tone="red"
fi

command_tone=""
if (( ${#command_actions[@]} )); then
  command_tone="yellow"
fi
if (( QUOTA_WARNING )); then
  command_tone="yellow"
fi
if (( QUOTA_BLOCKED )); then
  command_tone="red"
fi

if (( ! HOST_IS_SECURE )); then
  if [[ "$result_tone" == "green" ]]; then
    result_label="Codex to brrrr (insecure host)"
  fi
elif [[ "$result_tone" == "green" && "$command_tone" != "red" && "$auth_tone" == "green" && "$codex_tone" == "green" && "$wrapper_tone" == "green" ]]; then
  result_label="Codex go Brrrr!"
fi

  quota_limit="$QUOTA_LIMIT_PERCENT"
  if [[ ! "$quota_limit" =~ ^[0-9]+$ ]]; then
    quota_limit=100
  fi
  if (( quota_limit < 50 )); then
    quota_limit=50
  elif (( quota_limit > 100 )); then
    quota_limit=100
  fi
  QUOTA_LIMIT_PERCENT="$quota_limit"
  if (( QUOTA_HARD_FAIL )); then
    quota_summary="Deny launches at ≥${quota_limit}% usage."
  else
    quota_summary="Warn at ≥${quota_limit}% usage; continue running."
  fi

  partition_days="$QUOTA_WEEK_PARTITION"
  if [[ ! "$partition_days" =~ ^[0-9]+$ ]]; then
    partition_days=0
  fi
  if (( partition_days != 5 && partition_days != 7 )); then
    partition_days=0
  fi
  QUOTA_WEEK_PARTITION="$partition_days"

  command_line=""
  if [[ -n "$command_label" ]]; then
    command_line="Command: $(colorize "$command_label" "$command_tone")"
  fi

  core_bits=()
  api_detail=""
  [[ "$api_tone" != "green" ]] && api_detail="$api_label"
  core_bits+=("$(format_core_entry "API" "$api_tone" "$api_detail")")

  auth_detail=""
  if [[ "$auth_tone" != "green" ]]; then
    auth_detail="$auth_label"
  fi
  core_bits+=("$(format_core_entry "Auth" "$auth_tone" "$auth_detail")")

  prompt_detail=""
  if [[ "$prompt_tone" == "green" ]]; then
    if [[ "$prompt_label" =~ local[[:space:]]+([0-9]+).*remote[[:space:]]+([0-9]+) ]]; then
      prompt_detail="(${BASH_REMATCH[1]}/${BASH_REMATCH[2]})"
    fi
  else
    prompt_detail="$prompt_label"
  fi
  core_bits+=("$(format_core_entry "Prompts" "$prompt_tone" "$prompt_detail")")

  skill_detail=""
  if [[ "$skill_tone" == "green" ]]; then
    if [[ "$skill_label" =~ local[[:space:]]+([0-9]+).*remote[[:space:]]+([0-9]+) ]]; then
      skill_detail="(${BASH_REMATCH[1]}/${BASH_REMATCH[2]})"
    fi
  else
    skill_detail="$skill_label"
  fi
  core_bits+=("$(format_core_entry "Skills" "$skill_tone" "$skill_detail")")

  if [[ -n "$runner_label" ]]; then
    core_bits+=("$(format_core_entry "Runner" "$runner_tone")")
  fi

  # MCP status (managed codex-orchestrator server in config.toml).
  if [[ -f "$CONFIG_PATH" ]]; then
    mcp_tone="yellow"
    if toml_table_enabled "$CONFIG_PATH" "mcp_servers.cdx"; then
      mcp_tone="green"
    else
      case $? in
        1) mcp_tone="yellow" ;; # explicitly disabled
        2)
          if toml_table_enabled "$CONFIG_PATH" "mcp_servers.codex-orchestrator"; then
            mcp_tone="green"
          else
            mcp_tone="yellow"
          fi
          ;;
      esac
    fi
    core_bits+=("$(format_core_entry "MCP" "$mcp_tone")")
  fi

  policy_entry="Policy: $( (( QUOTA_HARD_FAIL )) && printf "Deny" || printf "Warn" )"
  core_line_bits=("${core_bits[@]}" "$policy_entry")
  core_line="Core: $(join_with_sep ' | ' "${core_line_bits[@]}")"

  versions_bits=()
  versions_bits+=("$(format_version_entry "codex" "$codex_tone" "$codex_installed_display" "$codex_target_display" "$codex_status_display")")
  versions_bits+=("$(format_version_entry "wrapper" "$wrapper_tone" "$wrapper_installed_display" "$wrapper_target_display" "$wrapper_status_display")")
  if [[ -n "$agents_label" ]]; then
    if [[ "$agents_tone" == "green" ]]; then
      versions_bits+=("AGENTS ✅")
    else
      versions_bits+=("$(format_core_entry "AGENTS" "$agents_tone" "$agents_label")")
    fi
  fi
  if [[ -n "$config_label" ]]; then
    if [[ "$config_tone" == "green" ]]; then
      versions_bits+=("config.toml ✅")
    else
      versions_bits+=("$(format_core_entry "config" "$config_tone" "$config_label")")
    fi
  fi
  versions_line=""
  if (( ${#versions_bits[@]} )); then
    versions_line="Versions: $(join_with_sep ' | ' "${versions_bits[@]}")"
  fi

  usage_bits=()
  if [[ -n "$HOST_API_CALLS" ]]; then
    usage_bits+=("calls ${HOST_API_CALLS}")
  fi
  token_bits=()
  [[ -n "$HOST_TOKENS_MONTH_TOTAL" ]] && token_bits+=("total ${HOST_TOKENS_MONTH_TOTAL}")
  token_line=""
  if (( ${#token_bits[@]} )); then
    token_line="$(join_with_sep ' / ' "${token_bits[@]}")"
  fi
  if [[ -n "$token_line" ]]; then
    usage_bits+=("tokens ${token_line}")
  fi
  if [[ -n "$usage_summary" ]]; then
    usage_bits+=("$usage_summary")
  fi
  usage_line=""
  if (( ${#usage_bits[@]} )); then
    usage_line="Usage: $(join_with_sep ' | ' "${usage_bits[@]}")"
  fi

  result_line="Result: $(colorize "$result_label" "$result_tone")"
  if [[ "${HOST_VIP:-0}" == "1" ]]; then
    result_line+=" 👑"
  fi
  primary_reset_hint=""
  primary_quota_segment=""
  qline=$(render_quota_line "$CHATGPT_PRIMARY_USED" "$CHATGPT_PRIMARY_RESET_AFTER" "$CHATGPT_PRIMARY_RESET_AT")
  if [[ -n "$qline" ]]; then
    qtone="${qline%%$'\t'*}"
    rest="${qline#*$'\t'}"
    qtext="${rest%%$'\t'*}"
    qnote="${rest#*$'\t'}"
    primary_reset_hint="$qnote"
    qnote_disp="$qnote"
    if [[ -n "$qnote_disp" ]]; then
      printf -v qnote_disp "%b" "${DIM}${qnote_disp}${RESET}"
    fi
    # qtext looks like "  7% [bars]"
    primary_quota_segment="$(colorize "$qtext" "$qtone")"
    if [[ -n "$qnote_disp" ]]; then
      primary_quota_segment+=" ${qnote_disp}"
    fi
  fi

  secondary_reset_hint=""
  secondary_quota_segment=""
  qline=$(render_quota_line "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_RESET_AFTER" "$CHATGPT_SECONDARY_RESET_AT")
  if [[ -n "$qline" ]]; then
    qtone2="${qline%%$'\t'*}"
    rest2="${qline#*$'\t'}"
    qtext2="${rest2%%$'\t'*}"
    qnote2="${rest2#*$'\t'}"
    projection_note=""
    projection_alert=0
    projection_pct="$(project_quota_usage "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_LIMIT" "$CHATGPT_SECONDARY_RESET_AFTER")"
    if [[ -n "$projection_pct" ]]; then
      if (( projection_pct >= 100 )); then
        projection_note="proj 100% at reset"
        projection_alert=1
      else
        projection_note="proj ~${projection_pct}% at reset"
      fi
    fi
    qnote_full="$(join_with_semicolon "$qnote2" "$projection_note")"
    secondary_reset_hint="$qnote_full"
    qnote2_disp="$qnote_full"
    if [[ -n "$qnote2_disp" ]]; then
      if (( projection_alert )); then
        printf -v qnote2_disp "%b" "${RED}${BOLD}${qnote2_disp}${RESET}"
      else
        printf -v qnote2_disp "%b" "${DIM}${qnote2_disp}${RESET}"
      fi
    fi
    secondary_quota_segment="$(colorize "$qtext2" "$qtone2")"
    if [[ -n "$qnote2_disp" ]]; then
      secondary_quota_segment+=" ${qnote2_disp}"
    fi
  fi

  daily_quota_segment=""
  daily_reset_hint=""
  daily_allowance_used_pct=""
  if (( QUOTA_WEEK_PARTITION == 5 || QUOTA_WEEK_PARTITION == 7 )); then
    if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
      partition_days="$QUOTA_WEEK_PARTITION"
      allowance_per_day=$(( (100 + partition_days / 2) / partition_days ))
      (( allowance_per_day < 1 )) && allowance_per_day=1
      daily_used="${CHATGPT_DAILY_USED:-}"
      if [[ "$daily_used" =~ ^[0-9]+$ ]]; then
        bar_pct=$(( (daily_used * 100 + allowance_per_day / 2) / allowance_per_day ))
        (( bar_pct < 0 )) && bar_pct=0
        (( bar_pct > 999 )) && bar_pct=999
        daily_allowance_used_pct=$bar_pct
        bar_display=$bar_pct
        (( bar_display > 100 )) && bar_display=100
        bar="$(build_quota_bar "$bar_display" "$QUOTA_BAR_WIDTH")"
        qtone3="green"
        if (( bar_pct >= 95 )); then
          qtone3="red"
        elif (( bar_pct >= 80 )); then
          qtone3="orange"
        fi
        printf -v qtext3 "%3d%% [%s]" "$bar_pct" "$bar"
        note_parts=()
        note_parts+=("today used ${daily_used}% of week")
        note_parts+=("allowance ${allowance_per_day}%/day | ${partition_days} day partition")
        daily_reset_hint="$(join_with_semicolon "${note_parts[@]}")"
        note3_disp="$daily_reset_hint"
        if [[ -n "$note3_disp" ]]; then
          printf -v note3_disp "%b" "${DIM}${note3_disp}${RESET}"
        fi
        daily_quota_segment="$(colorize "$qtext3" "$qtone3")"
        if [[ -n "$note3_disp" ]]; then
          daily_quota_segment+=" ${note3_disp}"
        fi
      fi
    fi
  fi

  if (( QUOTA_WEEK_PARTITION == 5 || QUOTA_WEEK_PARTITION == 7 )) && [[ -z "$daily_quota_segment" ]]; then
    allowance_per_day=$(( (100 + QUOTA_WEEK_PARTITION / 2) / QUOTA_WEEK_PARTITION ))
    bar="$(build_quota_bar 0 "$QUOTA_BAR_WIDTH")"
    qtext3=$(printf "%3d%% [%s]" 0 "$bar")
    note3_disp=$(printf "%b" "${DIM}allowance ${allowance_per_day}%/day | ${QUOTA_WEEK_PARTITION} day partition${RESET}")
    daily_quota_segment="$(colorize "$qtext3" "green") ${note3_disp}"
    daily_allowance_used_pct=0
  fi

  quota_warn_threshold=$(( quota_limit - 10 ))
  if (( quota_warn_threshold < 0 )); then
    quota_warn_threshold=0
  fi
  quota_reasons=()
  quota_warnings=()
  if [[ "${CHATGPT_STATUS,,}" == "limit_reached" ]]; then
    quota_reasons+=("ChatGPT status limit_reached")
  fi
  if [[ "$CHATGPT_PRIMARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_PRIMARY_USED >= quota_limit )); then
      reason="5h quota reached (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_PRIMARY_USED >= quota_warn_threshold )); then
      reason="5h quota high (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_SECONDARY_USED >= quota_limit )); then
      reason="week quota reached (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_SECONDARY_USED >= quota_warn_threshold )); then
      reason="week quota high (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if [[ "$daily_allowance_used_pct" =~ ^[0-9]+$ ]]; then
    if (( daily_allowance_used_pct >= quota_limit )); then
      reason="daily allowance reached (${daily_allowance_used_pct}% of allowance"
      [[ -n "$daily_reset_hint" ]] && reason+="; ${daily_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( daily_allowance_used_pct >= quota_warn_threshold )); then
      reason="daily allowance high (${daily_allowance_used_pct}% of allowance"
      [[ -n "$daily_reset_hint" ]] && reason+="; ${daily_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if (( ${#quota_reasons[@]} )); then
    QUOTA_BLOCKED=1
    QUOTA_BLOCK_REASON="$(human_join "${quota_reasons[@]}")"
  fi
  if (( ${#quota_warnings[@]} )); then
    QUOTA_WARNING=1
    QUOTA_WARNING_REASON="$(human_join "${quota_warnings[@]}")"
  fi

	  if (( ! wrapper_updated )); then
	    format_label_prefix() {
	      local label="$1"
	      local width="${SUMMARY_LABEL_WIDTH:-12}"
	      printf "%-${width}s: " "$label"
	    }
	
	    log_info "$(format_label_prefix "Core")${core_line#Core: }"
	    if [[ -n "$versions_line" ]]; then
	      log_info "$(format_label_prefix "Versions")${versions_line#Versions: }"
	    fi
	    if [[ -n "$usage_line" ]]; then
	      log_info "$(format_label_prefix "Usage")${usage_line#Usage: }"
	    fi
	    quota_label_base="Quota"
	    if [[ -n "$primary_quota_segment" ]]; then
	      quota_line="${primary_quota_segment}"
	      if (( QUOTA_WARNING )) || (( QUOTA_BLOCKED )); then
	        quota_line+=" ⚠"
	      fi
	      log_info "$(format_label_prefix "${quota_label_base} 5h")${quota_line}"
	    fi
	    if [[ -n "$daily_quota_segment" ]]; then
	      quota_line3="${daily_quota_segment}"
	      if (( QUOTA_WARNING )) || (( QUOTA_BLOCKED )); then
	        quota_line3+=" ⚠"
	      fi
	      log_info "$(format_label_prefix "${quota_label_base} day")${quota_line3}"
	    fi
	    if [[ -n "$secondary_quota_segment" ]]; then
	      quota_line2="${secondary_quota_segment}"
	      if (( QUOTA_WARNING )) || (( QUOTA_BLOCKED )); then
	        quota_line2+=" ⚠"
	      fi
	      log_info "$(format_label_prefix "${quota_label_base} wk")${quota_line2}"
	    fi
	    log_info "$(format_label_prefix "Result")${result_line#Result: }"
	  fi

if (( wrapper_updated )) && (( ! CODEX_EXIT_AFTER_UPDATE )); then
  if [[ "${CODEX_WRAPPER_RESTARTED:-0}" == "1" ]]; then
    log_error "Wrapper update loop detected; aborting."
    exit 1
  fi
  log_warn "Wrapper updated; restarting cdx to load the new wrapper."
  CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"
fi

AUTH_LAUNCH_ALLOWED=0
AUTH_LAUNCH_REASON=""
case "$AUTH_PULL_STATUS" in
  ok)
    AUTH_LAUNCH_ALLOWED=1
    ;;
  offline)
    offline_launch_hint=""
    [[ -n "$AUTH_PULL_REASON" ]] && offline_launch_hint=" (${AUTH_PULL_REASON})"
    if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; using cached auth.json"
    elif (( HAS_LOCAL_AUTH )) && (( HOST_IS_SECURE )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; secure host using cached auth.json"
    elif (( HAS_LOCAL_AUTH )); then
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; cached auth.json older than allowed window"
    else
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint} and no cached auth.json"
    fi
    ;;
  invalid)
    AUTH_LAUNCH_REASON="Invalid API key; download a fresh wrapper or rotate the key."
    ;;
  missing-config)
    AUTH_LAUNCH_REASON="Auth configuration missing (base URL or API key)."
    ;;
  disabled)
    AUTH_LAUNCH_REASON="Auth API disabled by administrator."
    ;;
  insecure)
    AUTH_LAUNCH_REASON="Insecure host API disabled; enable the host window in the admin dashboard."
    ;;
  fail)
    AUTH_LAUNCH_REASON="Auth sync failed; check API connectivity."
    ;;
  *)
    AUTH_LAUNCH_REASON="Auth unavailable; fix sync before retrying."
    ;;
esac

if (( AUTH_LAUNCH_ALLOWED == 1 )) && (( QUOTA_BLOCKED )); then
  if (( QUOTA_HARD_FAIL )); then
    AUTH_LAUNCH_ALLOWED=0
    AUTH_LAUNCH_REASON="${QUOTA_BLOCK_REASON:-ChatGPT quota reached}"
  else
    log_warn "ChatGPT quota reached: ${QUOTA_BLOCK_REASON:-see details above}. Continuing (warn mode)."
  fi
fi

if (( QUOTA_WARNING )) && (( AUTH_LAUNCH_ALLOWED == 1 )); then
  log_warn "ChatGPT quota near limit: ${QUOTA_WARNING_REASON:-see usage above}."
fi

if (( AUTH_LAUNCH_ALLOWED == 0 )); then
  log_error "${AUTH_LAUNCH_REASON:-Auth unavailable; refusing to start Codex. Re-run after fixing API key or provisioning auth.}"
  exit 1
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  log_warn "${AUTH_LAUNCH_REASON} (last_refresh ${ORIGINAL_LAST_REFRESH:-unknown})."
fi

cleanup() {
  local exit_status=$?
  trap - EXIT
  push_slash_commands_if_changed || true
  push_skills_if_changed || true
  if (( CODEX_COMMAND_STARTED )) && (( SYNC_PUSH_COMPLETED == 0 )); then
    push_auth_if_changed "push" || true
  fi
  # Emit final auth push status if determined
  if [[ -n "$AUTH_PUSH_RESULT" ]]; then
    log_info "Auth push | ${AUTH_PUSH_RESULT} | ${AUTH_PUSH_REASON:-n/a}"
  fi
  if (( PURGE_AUTH_AFTER_RUN )) && (( CODEX_COMMAND_STARTED )) && [[ -f "$HOME/.codex/auth.json" ]]; then
    remove_path "$HOME/.codex/auth.json" "auth.json (insecure host)"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

if (( AUTH_LAUNCH_ALLOWED == 0 )); then
  exit 1
fi

apply_otel_env_from_config() {
  if [[ ! -f "$CONFIG_PATH" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  local line key val
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      OTEL_*|CODEX_OTEL_LOG_USER_PROMPT)
        export "$key=$val"
        ;;
    esac
  done < <(otel_env_from_config_python 2>/dev/null || true)
}

apply_otel_env_from_config

run_codex_command() {
  local tmp_output status
  tmp_output="$(mktemp)"
  set +e
  if [[ -t 1 && "$CODEX_NO_PTY" != "1" ]]; then
    local cmd_line=("$CODEX_REAL_BIN" "$@")
    if [[ "$CODEX_NO_SCRIPT" != "1" ]] && command -v script >/dev/null 2>&1; then
      # Use script to keep a PTY and capture output to a typescript file while streaming to the real TTY.
      local cmd_str
      cmd_str="$(printf '%q ' "${cmd_line[@]}")"
      script -qef "$tmp_output" -c "$cmd_str"
      status=$?
    elif command -v python3 >/dev/null 2>&1; then
      # Fallback PTY using Python's pty module when script is unavailable.
      status=0
      python3 - "$tmp_output" "${cmd_line[@]}" <<'PY'
import os, sys, pty
log_path = sys.argv[1]
cmd = sys.argv[2:]
with open(log_path, "wb") as log:
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    try:
        while True:
            try:
                data = os.read(fd, 1024)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
            log.write(data)
            log.flush()
    except KeyboardInterrupt:
        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status))
PY
      status=$?
    else
      # Last-resort: run directly to preserve TTY; no tee (token usage may be skipped).
      "${cmd_line[@]}"
      status=$?
    fi
    if [[ ${status:-1} -ne 0 ]]; then
      # Fallback: run without PTY to avoid terminal quirks (e.g., notebooks).
      "${cmd_line[@]}" 2>&1 | tee "$tmp_output"
      status=${PIPESTATUS[0]}
    fi
  else
    "$CODEX_REAL_BIN" "$@" 2>&1 | tee "$tmp_output"
    status=${PIPESTATUS[0]}
  fi
  set -e
  if [[ -f "$tmp_output" ]]; then
    send_token_usage_if_present "$tmp_output"
    rm -f "$tmp_output"
  fi
  return "$status"
}

	if [[ -n "${CODEX_PROFILE_CANDIDATE:-}" ]]; then
	  candidate="$CODEX_PROFILE_CANDIDATE"
	  CODEX_PROFILE_CANDIDATE=""
	  if [[ "$candidate" =~ ^[A-Za-z0-9_-]+$ && -f "$CONFIG_PATH" ]] && grep -qE "^[[:space:]]*\\[profiles\\.${candidate}\\][[:space:]]*$" "$CONFIG_PATH"; then
	    set -- --profile "$candidate" "$@"
	  else
	    set -- "$candidate" "$@"
	  fi
	fi

	if [[ -n "$CODEX_HOST_MODEL" ]]; then
	  set -- --model "$CODEX_HOST_MODEL" "$@"
	fi

if [[ -n "$CODEX_HOST_REASONING_EFFORT" ]]; then
  set -- --reasoning-effort "$CODEX_HOST_REASONING_EFFORT" "$@"
fi

CODEX_COMMAND_STARTED=1
if run_codex_command "$@"; then
  cmd_status=0
else
  cmd_status=$?
fi
push_auth_if_changed "push" || true
exit "$cmd_status"
