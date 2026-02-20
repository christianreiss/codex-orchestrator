
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

if [[ "$platform_os" == "Linux" ]]; then
  if (( can_manage_codex )); then
    ensure_commands curl unzip script
  fi
elif [[ "$platform_os" == "Darwin" ]]; then
  ensure_commands python3 curl unzip
fi

LOCAL_VERSION_RAW="$("$CODEX_REAL_BIN" -V 2>/dev/null || true)"
LOCAL_VERSION="$(normalize_version "$LOCAL_VERSION_RAW")"
LOCAL_VERSION_UNKNOWN=0
if [[ -z "$LOCAL_VERSION" ]]; then
  LOCAL_VERSION_UNKNOWN=1
  log_warn "Could not determine local Codex version; attempting to refresh Codex before launch."
fi

# Guard mutating sync/update work when another cdx run is already active.
if (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
  acquire_run_lock_or_mark_concurrent || true
fi
if (( CDX_ACTIVE_RUN_DETECTED )); then
  concurrent_reason="${CDX_ACTIVE_RUN_INFO:-active cdx run detected}"
  if (( CDX_RUN_GUARD_WARNING_EMITTED == 0 )); then
    log_warn "${concurrent_reason}; skipping sync/update mutations for this run. Use --allow-concurrent-sync to override."
    CDX_RUN_GUARD_WARNING_EMITTED=1
  fi
  AUTH_PULL_STATUS="concurrent"
  AUTH_PULL_REASON="$concurrent_reason"
  PROMPT_SYNC_STATUS="skip"
  PROMPT_SYNC_REASON="active-run"
  SKILL_SYNC_STATUS="skip"
  SKILL_SYNC_REASON="active-run"
  AGENTS_SYNC_STATUS="skip"
  AGENTS_SYNC_REASON="active-run"
  CONFIG_SYNC_STATUS="skip"
  CONFIG_SYNC_REASON="active-run"
  # Keep concurrent mode non-mutating, but refresh quota/policy metadata.
  load_sync_config
  if command -v python3 >/dev/null 2>&1 && [[ -n "$CODEX_SYNC_API_KEY" && -n "$CODEX_SYNC_BASE_URL" ]]; then
    sync_auth_with_api "pull-readonly" "1" || true
    AUTH_PULL_STATUS="concurrent"
    AUTH_PULL_REASON="$concurrent_reason"
  fi
else
  # Early auth + versions sync (single POST), captures target versions and hydrates auth if needed.
  sync_auth_with_api "pull" || true
  sync_slash_commands_pull || true
  sync_skills_pull || true
  sync_agents_pull || true
  sync_config_pull || true
fi
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
HAS_VALID_LOCAL_AUTH=0
if (( HAS_LOCAL_AUTH )) && validate_auth_json_file "$HOME/.codex/auth.json"; then
  HAS_VALID_LOCAL_AUTH=1
fi

if (( ! CODEX_SKIP_MOTD )) && (( ! CODEX_SILENT )); then
  print_motd
fi

os_name="$(uname -s)"
arch_name="$(uname -m)"
asset_name=""
skip_update_check=0
if (( CDX_ACTIVE_RUN_DETECTED )); then
  skip_update_check=1
elif (( ! can_manage_codex )); then
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
  Darwin)
    case "$arch_name" in
      x86_64|amd64)
        asset_name="codex-x86_64-apple-darwin.tar.gz"
        ;;
      aarch64|arm64)
        asset_name="codex-aarch64-apple-darwin.tar.gz"
        ;;
      *)
        log_warn "Unsupported macOS architecture (${arch_name}); skipping update check."
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
      elif version_lt "$norm_local" "$norm_remote"; then
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
      fresh_fields=()
      if payload_raw="$(read_cached_payload "$tmp_payload")"; then
        while IFS= read -r line; do
          fresh_fields+=("$line")
        done <<< "$payload_raw"
      fi
      if (( ${#fresh_fields[@]} >= 5 )); then
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
  if (( CDX_ACTIVE_RUN_DETECTED )); then
    codex_status_note="active cdx run"
  else
    codex_status_note="not permitted to manage Codex (need root)"
  fi
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

if (( ! CDX_ACTIVE_RUN_DETECTED )) && { [[ "$AUTH_PULL_STATUS" == "ok" || "$CODEX_FORCE_WRAPPER_UPDATE" == "1" ]]; }; then
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
    if current_wrapper_sha="$(sha256_file "$SCRIPT_REAL" 2>/dev/null)" && [[ -n "$current_wrapper_sha" ]]; then
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
      case "$(lowercase "$CODEX_SYNC_ALLOW_INSECURE")" in
        1|true|yes)
          curl_args+=("-k")
          ;;
      esac
      if curl "${curl_args[@]}" "$target_wrapper_url" -o "$tmpwrapper"; then
        dl_sha="$(sha256_file "$tmpwrapper" 2>/dev/null || true)"
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
elif (( CDX_ACTIVE_RUN_DETECTED )); then
  wrapper_status_label="Check skipped"
  wrapper_status_note="active cdx run"
fi

if (( CODEX_EXIT_AFTER_UPDATE )); then
  release_run_lock_if_held || true
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
  # Avoid box-drawing chars: some environments render them as mojibake.
  printf "%b" "${DIM}$(printf '%*s' "$w" '' | tr ' ' '-')${RESET}"
}

summary_header() {
  local title="$1" tone="${2-}"
  local ts=""
  if command -v date >/dev/null 2>&1; then
    ts="$(date '+%Y-%m-%d %H:%M' 2>/dev/null || true)"
  fi
  local left="cdx"
  [[ -n "$ts" ]] && left+=" ${DIM}${ts}${RESET}"
  local right=""
  [[ -n "$title" ]] && right="$(colorize "$title" "$tone")"
  # Keep it single-line; row wrapping is handled below.
  if [[ -n "$right" ]]; then
    printf "%s%s%s" "$left" "${SUMMARY_GUTTER}•${SUMMARY_GUTTER}" "$right"
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

  local text="${name} ${state}"
  case "$result" in
    skipped|failed|error)
      if [[ -n "$reason" ]]; then
        text+=" (${reason})"
      fi
      ;;
  esac
  if [[ "$tone" != "green" ]]; then
    text="$(colorize "$text" "$tone")"
  fi
  printf "%s" "$text"
}

format_run_cost_value() {
  local raw="$1"
  if [[ "$raw" =~ ^-?[0-9]+([.][0-9]+)?$ ]]; then
    LC_NUMERIC=C printf "%.2f$" "$raw"
    return
  fi
  printf "%s" "$raw"
}

print_run_exit_footer() {
  (( CODEX_COMMAND_STARTED )) || return 0

  local usage_label="Run usage"
  local cost_label="Run cost"
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
    cost_text="${cost_prefix}$(format_run_cost_value "${USAGE_PUSH_COST}")"
  else
    cost_text="${cost_prefix}unavailable (${cost_reason})"
    if [[ "${USAGE_PUSH_RESULT:-}" == "failed" ]]; then
      cost_text="$(colorize "$cost_text" "red")"
    else
      cost_text="$(colorize "$cost_text" "yellow")"
    fi
  fi

  local usage_sync=""
  local auth_sync=""
  usage_sync="$(format_footer_sync_fragment "usage" "${USAGE_PUSH_RESULT:-}" "${USAGE_PUSH_REASON:-}")"
  auth_sync="$(format_footer_sync_fragment "auth" "${AUTH_PUSH_RESULT:-}" "${AUTH_PUSH_REASON:-}")"
  local sync_text="${usage_sync}; ${auth_sync}"

  log_info "$(summary_divider)"
  log_info "$(format_simple_row "$usage_label" "$usage_text")"
  log_info "$(format_simple_row "$cost_label" "$cost_text")"
  log_info "$(format_simple_row "$sync_label" "$sync_text")"
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
  probe="$(CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_CA_FILE" <<'PY'
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

DOCTOR_FAILURES=0
print_doctor_report() {
  local failures=0
  local hints=()

  local dep_python="missing"
  local dep_curl="missing"
  local dep_script="missing"
  command -v python3 >/dev/null 2>&1 && dep_python="ok"
  command -v curl >/dev/null 2>&1 && dep_curl="ok"
  command -v script >/dev/null 2>&1 && dep_script="ok"

  dep_bits=()
  if [[ "$dep_python" == "ok" ]]; then
    dep_bits+=("python3 ✅")
  else
    dep_bits+=("python3 $(colorize "missing" "red")")
    failures=$(( failures + 1 ))
    hints+=("Install python3; sync and auth checks require it.")
  fi
  if [[ "$dep_curl" == "ok" ]]; then
    dep_bits+=("curl ✅")
  else
    dep_bits+=("curl $(colorize "missing" "yellow")")
    hints+=("Install curl to enable wrapper/Codex download updates.")
  fi
  if [[ "$dep_script" == "ok" ]]; then
    dep_bits+=("script ✅")
  else
    dep_bits+=("script $(colorize "missing" "yellow")")
    hints+=("Install util-linux script for PTY capture, or run with CODEX_NO_PTY=1.")
  fi

  local auth_freshness=""
  if (( HAS_LOCAL_AUTH )); then
    if (( LOCAL_AUTH_IS_FRESH )); then
      auth_freshness="fresh (${ORIGINAL_LAST_REFRESH:-unknown})"
    elif (( HOST_IS_SECURE )) && (( LOCAL_AUTH_IS_RECENT )); then
      auth_freshness="recent secure-cache (${ORIGINAL_LAST_REFRESH:-unknown})"
    else
      auth_freshness="$(colorize "stale" "yellow") (${ORIGINAL_LAST_REFRESH:-unknown})"
      hints+=("Refresh auth soon; cached auth.json is older than the normal window.")
    fi
  else
    auth_freshness="$(colorize "missing" "red")"
    failures=$(( failures + 1 ))
    hints+=("No local auth.json available; check API connectivity and host registration.")
  fi

  local config_state_label=""
  if [[ -f "$CONFIG_PATH" ]]; then
    config_state_label="${CONFIG_SYNC_STATUS:-unknown}"
    [[ -n "$CONFIG_STATE" ]] && config_state_label+=" (${CONFIG_STATE})"
  else
    config_state_label="missing local file"
    if [[ "$CONFIG_SYNC_STATUS" != "ok" ]]; then
      hints+=("config.toml is missing locally; restore API connectivity and rerun sync.")
    fi
  fi

  local api_probe="fail\tunreachable"
  local api_probe_rc=1
  if api_probe="$(doctor_probe_api_versions)"; then
    api_probe_rc=0
  else
    api_probe_rc=$?
  fi
  local api_probe_state="${api_probe%%$'\t'*}"
  local api_probe_detail="${api_probe#*$'\t'}"
  local api_probe_label="$api_probe_detail"
  case "$api_probe_state" in
    ok)
      api_probe_label="$(colorize "reachable" "green")"
      [[ -n "$api_probe_detail" ]] && api_probe_label+=" (${api_probe_detail})"
      ;;
    skip)
      api_probe_label="$(colorize "skipped" "yellow") (${api_probe_detail})"
      ;;
    *)
      api_probe_label="$(colorize "unreachable" "red") (${api_probe_detail})"
      failures=$(( failures + 1 ))
      hints+=("Check ${CODEX_SYNC_BASE_URL%/}/versions reachability, DNS/TLS, firewall, and CA settings.")
      ;;
  esac

  local pty_file="$HOME/.codex/.cdx_no_pty"
  local pty_label="auto-detect clear"
  if [[ -f "$pty_file" ]]; then
    pty_label="$(colorize "auto-disabled" "yellow") (${pty_file})"
    hints+=("PTY capture is auto-disabled on this host; remove ${pty_file} or set CODEX_FORCE_PTY=1 to retest.")
  fi

  local sync_label="auth=${AUTH_PULL_STATUS:-unknown} prompts=${PROMPT_SYNC_STATUS:-unknown} skills=${SKILL_SYNC_STATUS:-unknown} agents=${AGENTS_SYNC_STATUS:-unknown} config=${CONFIG_SYNC_STATUS:-unknown}"
  case "$AUTH_PULL_STATUS" in
    invalid)
      failures=$(( failures + 1 ))
      hints+=("API key rejected. Download a fresh wrapper or rotate the host key in admin.")
      ;;
    missing-config)
      failures=$(( failures + 1 ))
      hints+=("Wrapper is missing baked sync config. Reinstall cdx from /install token.")
      ;;
    insecure)
      failures=$(( failures + 1 ))
      hints+=("Insecure host window is closed. Enable the host window in admin.")
      ;;
    insecure-denied)
      failures=$(( failures + 1 ))
      hints+=("Host approval was denied. Approve/re-enable the host in admin and retry.")
      ;;
    offline)
      hints+=("API is offline; cached auth may work temporarily but sync/push is limited.")
      ;;
    concurrent)
      hints+=("Another cdx process is active; this run skips sync/update mutations unless --allow-concurrent-sync is passed.")
      ;;
  esac

  log_info "$(format_simple_row "Doctor deps" "$(join_with_sep ' | ' "${dep_bits[@]}")")"
  log_info "$(format_simple_row "Doctor paths" "codex=${CODEX_REAL_BIN}; wrapper=${SCRIPT_REAL}")"
  log_info "$(format_simple_row "Doctor auth" "freshness=${auth_freshness}; status=${AUTH_PULL_STATUS:-unknown}")"
  log_info "$(format_simple_row "Doctor sync" "$sync_label")"
  log_info "$(format_simple_row "Doctor cfg" "path=${CONFIG_PATH}; state=${config_state_label}")"
  log_info "$(format_simple_row "Doctor api" "$api_probe_label")"
  log_info "$(format_simple_row "Doctor pty" "$pty_label")"

  if (( ${#hints[@]} )); then
    local hint
    for hint in "${hints[@]}"; do
      log_warn "Doctor hint: ${hint}"
    done
  fi

  DOCTOR_FAILURES=$failures
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
  insecure-denied)
    api_label="Insecure approval denied"
    api_tone="red"
    ;;
  concurrent)
    api_label="Concurrent guard active"
    api_tone="yellow"
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
elif [[ "$AUTH_PULL_STATUS" == "insecure-denied" ]]; then
  auth_label="insecure host approval denied"
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    auth_label="concurrent guard active; using local auth.json"
  else
    auth_label="concurrent guard active; local auth.json missing or invalid"
  fi
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
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
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
  state="$(lowercase "$RUNNER_STATE")"
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
  result_parts+=("codex $(lowercase "$codex_status_label")")
fi
if (( wrapper_updated )); then
  result_parts+=("wrapper updated")
elif (( wrapper_update_failed )); then
  result_parts+=("wrapper update failed")
else
  result_parts+=("wrapper $(lowercase "$wrapper_status_label")")
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
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    result_parts+=("auth local-only (active cdx run)")
  else
    result_parts+=("auth unavailable (active cdx run; local auth invalid)")
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
  case "$(lowercase "$codex_status_label")" in
    update\ available|check\ skipped|update\ skipped)
      codex_tone="yellow"
      ;;
  update\ failed|api\ unavailable)
    codex_tone="red"
    ;;
esac
(( codex_update_failed )) && codex_tone="red"

wrapper_tone="green"
case "$(lowercase "$wrapper_status_label")" in
  update\ available|update\ skipped|check\ skipped)
    wrapper_tone="yellow"
    ;;
  update\ failed)
    wrapper_tone="red"
    ;;
esac
(( wrapper_update_failed )) && wrapper_tone="red"

result_tone="green"
if (( codex_update_failed )) || (( wrapper_update_failed )) || { [[ "$AUTH_PULL_STATUS" != "ok" ]] && [[ "$AUTH_PULL_STATUS" != "offline" ]] && [[ "$AUTH_PULL_STATUS" != "concurrent" ]]; }; then
  result_tone="red"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT) )); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  result_tone="yellow"
elif [[ "$(lowercase "$codex_status_label")" == "update available" ]] || [[ "$(lowercase "$wrapper_status_label")" == "update available" ]]; then
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

insecure_compact_ok=0
if (( ! HOST_IS_SECURE )); then
  if (( ! codex_updated )) && (( ! codex_update_failed )) \
    && (( ! wrapper_updated )) && (( ! wrapper_update_failed )) \
    && [[ "$AUTH_PULL_STATUS" == "ok" ]] \
    && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]] \
    && [[ "$PROMPT_SYNC_STATUS" == "ok" ]] \
    && [[ "${PROMPT_PULL_UPDATED:-0}" == "0" ]] \
    && [[ "${PROMPT_PUSHED:-0}" == "0" ]] \
    && [[ "${PROMPT_REMOVED:-0}" == "0" ]] \
    && [[ "${PROMPT_PUSH_ERRORS:-0}" == "0" ]] \
    && [[ "$SKILL_SYNC_STATUS" == "ok" ]] \
    && [[ "${SKILL_PULL_UPDATED:-0}" == "0" ]] \
    && [[ "${SKILL_PUSHED:-0}" == "0" ]] \
    && [[ "${SKILL_REMOVED:-0}" == "0" ]] \
    && [[ "${SKILL_PUSH_ERRORS:-0}" == "0" ]] \
    && [[ "$AGENTS_SYNC_STATUS" == "ok" ]] \
    && [[ "$AGENTS_STATE" == "unchanged" ]] \
    && [[ "$CONFIG_SYNC_STATUS" == "ok" ]] \
    && [[ "$CONFIG_STATE" == "unchanged" ]]; then
    insecure_compact_ok=1
  fi
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
    if (( insecure_compact_ok )); then
      result_label="Synced on insecure host; auth refreshed."
    elif [[ "$result_tone" == "green" ]]; then
      result_label="Ready on insecure host."
    fi
  elif [[ "$result_tone" == "green" && "$command_tone" != "red" && "$auth_tone" == "green" && "$codex_tone" == "green" && "$wrapper_tone" == "green" ]]; then
    result_label="Ready (Codex go brrrr)."
  fi

  # Prefer an ASCII-friendly table (no box drawing). The "card" style divider
  # and bullet header proved fragile across terminals/fonts.
  SUMMARY_STYLE="${CDX_SUMMARY_STYLE:-table}"

  lane_requested=""
  CODEX_EFFECTIVE_LANE_SOURCE=""
  if [[ "$CODEX_LANE_TARGET" == "normal" || "$CODEX_LANE_TARGET" == "spark" ]]; then
    lane_requested="$CODEX_LANE_TARGET"
    CODEX_EFFECTIVE_LANE_SOURCE="command"
  elif [[ "$HOST_LANE_PREFERENCE" == "normal" || "$HOST_LANE_PREFERENCE" == "spark" ]]; then
    lane_requested="$HOST_LANE_PREFERENCE"
    CODEX_EFFECTIVE_LANE_SOURCE="host"
  elif [[ "$(lowercase "$CHATGPT_ACTIVE_LANE")" == "spark" ]]; then
    lane_requested="spark"
    CODEX_EFFECTIVE_LANE_SOURCE="api"
  else
    lane_requested="normal"
    CODEX_EFFECTIVE_LANE_SOURCE="api"
  fi

  has_spark_lane=0
  if [[ -n "$CHATGPT_SPARK_PRIMARY_USED" || -n "$CHATGPT_SPARK_PRIMARY_LIMIT" || -n "$CHATGPT_SPARK_SECONDARY_USED" || -n "$CHATGPT_SPARK_SECONDARY_LIMIT" ]]; then
    has_spark_lane=1
  fi
  CODEX_EFFECTIVE_LANE="$lane_requested"
  if [[ "$CODEX_EFFECTIVE_LANE" == "spark" && "$has_spark_lane" != "1" ]]; then
    CODEX_EFFECTIVE_LANE="normal"
    if [[ -n "$CODEX_EFFECTIVE_LANE_SOURCE" ]]; then
      CODEX_EFFECTIVE_LANE_SOURCE="${CODEX_EFFECTIVE_LANE_SOURCE}:fallback"
    else
      CODEX_EFFECTIVE_LANE_SOURCE="fallback"
    fi
  fi
  if [[ "$CODEX_EFFECTIVE_LANE" != "spark" && "$CODEX_EFFECTIVE_LANE" != "normal" ]]; then
    CODEX_EFFECTIVE_LANE="normal"
  fi

  CHATGPT_ACTIVE_LANE="$CODEX_EFFECTIVE_LANE"
  if [[ "$CODEX_EFFECTIVE_LANE" == "spark" ]]; then
    CHATGPT_PRIMARY_USED="$CHATGPT_SPARK_PRIMARY_USED"
    CHATGPT_PRIMARY_LIMIT="$CHATGPT_SPARK_PRIMARY_LIMIT"
    CHATGPT_PRIMARY_RESET_AFTER="$CHATGPT_SPARK_PRIMARY_RESET_AFTER"
    CHATGPT_PRIMARY_RESET_AT="$CHATGPT_SPARK_PRIMARY_RESET_AT"
    CHATGPT_SECONDARY_USED="$CHATGPT_SPARK_SECONDARY_USED"
    CHATGPT_SECONDARY_LIMIT="$CHATGPT_SPARK_SECONDARY_LIMIT"
    CHATGPT_SECONDARY_RESET_AFTER="$CHATGPT_SPARK_SECONDARY_RESET_AFTER"
    CHATGPT_SECONDARY_RESET_AT="$CHATGPT_SPARK_SECONDARY_RESET_AT"
  else
    CHATGPT_PRIMARY_USED="$CHATGPT_NORMAL_PRIMARY_USED"
    CHATGPT_PRIMARY_LIMIT="$CHATGPT_NORMAL_PRIMARY_LIMIT"
    CHATGPT_PRIMARY_RESET_AFTER="$CHATGPT_NORMAL_PRIMARY_RESET_AFTER"
    CHATGPT_PRIMARY_RESET_AT="$CHATGPT_NORMAL_PRIMARY_RESET_AT"
    CHATGPT_SECONDARY_USED="$CHATGPT_NORMAL_SECONDARY_USED"
    CHATGPT_SECONDARY_LIMIT="$CHATGPT_NORMAL_SECONDARY_LIMIT"
    CHATGPT_SECONDARY_RESET_AFTER="$CHATGPT_NORMAL_SECONDARY_RESET_AFTER"
    CHATGPT_SECONDARY_RESET_AT="$CHATGPT_NORMAL_SECONDARY_RESET_AT"
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

  quota_lane_label="normal"
  if [[ "$(lowercase "$CHATGPT_ACTIVE_LANE")" == "spark" ]]; then
    quota_lane_label="spark"
  fi
  quota_lane_display="${quota_lane_label}"
  if [[ "$quota_lane_display" == "spark" ]]; then
    if output_supports_unicode; then
      quota_lane_display="${quota_lane_display} ⚡"
    else
      quota_lane_display="${quota_lane_display} (fast)"
    fi
  fi
  if [[ "$quota_lane_label" == "spark" && -n "$CHATGPT_SPARK_LIMIT_NAME" ]]; then
    quota_lane_display="${quota_lane_display} (${CHATGPT_SPARK_LIMIT_NAME})"
  fi

  partition_days="$QUOTA_WEEK_PARTITION"
  if [[ ! "$partition_days" =~ ^[0-9]+$ ]]; then
    partition_days=0
  fi
  if (( partition_days != 5 && partition_days != 7 )); then
    partition_days=0
  fi
  QUOTA_WEEK_PARTITION="$partition_days"

  bullet="$(section_bullet)"
  health_rows=()
  api_state="reachable"
  if [[ "$api_tone" != "green" ]]; then
    api_state="${api_label:-unreachable}"
    api_state="$(colorize "$api_state" "$api_tone")"
  fi
  health_rows+=("${bullet} API: ${api_state}")

  auth_state="synced"
  if [[ "$auth_tone" != "green" ]]; then
    auth_state="${auth_label:-needs attention}"
    auth_state="$(colorize "$auth_state" "$auth_tone")"
  fi
  health_rows+=("${bullet} Auth: ${auth_state}")

  prompt_state="in sync"
  if [[ "$prompt_tone" == "green" ]]; then
    if [[ "$prompt_label" =~ local[[:space:]]+([0-9]+).*remote[[:space:]]+([0-9]+) ]]; then
      prompt_state="in sync (${BASH_REMATCH[1]}/${BASH_REMATCH[2]})"
    fi
  else
    prompt_state="${prompt_label:-needs attention}"
    prompt_state="$(colorize "$prompt_state" "$prompt_tone")"
  fi
  health_rows+=("${bullet} Prompts: ${prompt_state}")

  skill_state="in sync"
  if [[ "$skill_tone" == "green" ]]; then
    if [[ "$skill_label" =~ local[[:space:]]+([0-9]+).*remote[[:space:]]+([0-9]+) ]]; then
      skill_state="in sync (${BASH_REMATCH[1]}/${BASH_REMATCH[2]})"
    fi
  else
    skill_state="${skill_label:-needs attention}"
    skill_state="$(colorize "$skill_state" "$skill_tone")"
  fi
  health_rows+=("${bullet} Skills: ${skill_state}")

  if [[ -n "$runner_label" ]]; then
    runner_state="healthy"
    if [[ "$runner_tone" != "green" ]]; then
      runner_state="$(colorize "$runner_label" "$runner_tone")"
    fi
    health_rows+=("${bullet} Runner: ${runner_state}")
  fi

  # MCP status (managed codex-orchestrator server in config.toml).
  mcp_tone=""
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
    mcp_state="enabled"
    if [[ "$mcp_tone" != "green" ]]; then
      mcp_state="$(colorize "disabled or not configured" "$mcp_tone")"
    fi
    health_rows+=("${bullet} MCP: ${mcp_state}")
  fi

  if (( QUOTA_HARD_FAIL )); then
    policy_state="deny launches at >=${quota_limit}%"
  else
    policy_state="warn at >=${quota_limit}%"
  fi
  health_rows+=("${bullet} Quota policy: ${policy_state}")

  version_rows=()
  codex_ver_inst="$(extract_version_token "$codex_installed_display")"
  codex_ver_target="$(extract_version_token "$codex_target_display")"
  codex_ver_line="${codex_ver_inst:-${codex_installed_display:-unknown}}"
  if [[ -n "$codex_ver_target" && "$codex_ver_target" != "$codex_ver_inst" ]]; then
    codex_ver_line+=" -> ${codex_ver_target}"
  fi
  if [[ "$codex_tone" == "green" ]]; then
    codex_ver_line+=" (current)"
  else
    codex_ver_line+=" ($(colorize "${codex_status_display:-needs attention}" "$codex_tone"))"
  fi
  version_rows+=("${bullet} Codex: ${codex_ver_line}")

  wrapper_ver_inst="$(extract_version_token "$wrapper_installed_display")"
  wrapper_ver_target="$(extract_version_token "$wrapper_target_display")"
  wrapper_ver_line="${wrapper_ver_inst:-${wrapper_installed_display:-unknown}}"
  if [[ -n "$wrapper_ver_target" && "$wrapper_ver_target" != "$wrapper_ver_inst" ]]; then
    wrapper_ver_line+=" -> ${wrapper_ver_target}"
  fi
  if [[ "$wrapper_tone" == "green" ]]; then
    wrapper_ver_line+=" (current)"
  else
    wrapper_ver_line+=" ($(colorize "${wrapper_status_display:-needs attention}" "$wrapper_tone"))"
  fi
  version_rows+=("${bullet} Wrapper: ${wrapper_ver_line}")

  if [[ -n "$agents_label" ]]; then
    agents_state="synced"
    if [[ "$agents_tone" != "green" ]]; then
      agents_state="$(colorize "$agents_label" "$agents_tone")"
    fi
    version_rows+=("${bullet} AGENTS.md: ${agents_state}")
  fi
  if [[ -n "$config_label" ]]; then
    config_state="synced"
    if [[ "$config_tone" != "green" ]]; then
      config_state="$(colorize "$config_label" "$config_tone")"
    fi
    version_rows+=("${bullet} config.toml: ${config_state}")
  fi

  usage_rows=()
  if [[ "$HOST_API_CALLS" =~ ^[0-9]+$ ]]; then
    usage_rows+=("${bullet} API calls (host total): $(format_grouped_int "$HOST_API_CALLS")")
  fi
  if [[ "$HOST_TOKENS_MONTH_TOTAL" =~ ^[0-9]+$ ]]; then
    usage_rows+=("${bullet} Tokens this month: $(format_grouped_int "$HOST_TOKENS_MONTH_TOTAL")")
  elif [[ -n "$HOST_TOKENS_MONTH_TOTAL" ]]; then
    usage_rows+=("${bullet} Tokens this month: ${HOST_TOKENS_MONTH_TOTAL}")
  fi
  if [[ -n "$usage_summary" ]]; then
    usage_rows+=("${bullet} Latest run: ${usage_summary}")
  fi
  if (( ${#usage_rows[@]} == 0 )); then
    usage_rows+=("${bullet} No host usage data reported yet.")
  fi

  result_line="$(colorize "$result_label" "$result_tone")"
  if [[ "${HOST_VIP:-0}" == "1" ]]; then
    if output_supports_unicode; then
      result_line+=" 👑"
    else
      result_line+=" (VIP)"
    fi
  fi
  lane_prefix=""
  if [[ "$quota_lane_label" == "spark" ]]; then
    lane_prefix="spark "
  fi

  other_lane_label=""
  other_lane_primary_used=""
  other_lane_primary_limit=""
  other_lane_primary_reset_after=""
  other_lane_primary_reset_at=""
  other_lane_secondary_used=""
  other_lane_secondary_limit=""
  other_lane_secondary_reset_after=""
  other_lane_secondary_reset_at=""
  if [[ "$quota_lane_label" == "spark" ]]; then
    other_lane_label="Normal"
    other_lane_primary_used="$CHATGPT_NORMAL_PRIMARY_USED"
    other_lane_primary_limit="$CHATGPT_NORMAL_PRIMARY_LIMIT"
    other_lane_primary_reset_after="$CHATGPT_NORMAL_PRIMARY_RESET_AFTER"
    other_lane_primary_reset_at="$CHATGPT_NORMAL_PRIMARY_RESET_AT"
    other_lane_secondary_used="$CHATGPT_NORMAL_SECONDARY_USED"
    other_lane_secondary_limit="$CHATGPT_NORMAL_SECONDARY_LIMIT"
    other_lane_secondary_reset_after="$CHATGPT_NORMAL_SECONDARY_RESET_AFTER"
    other_lane_secondary_reset_at="$CHATGPT_NORMAL_SECONDARY_RESET_AT"
  else
    other_lane_label="Spark"
    other_lane_primary_used="$CHATGPT_SPARK_PRIMARY_USED"
    other_lane_primary_limit="$CHATGPT_SPARK_PRIMARY_LIMIT"
    other_lane_primary_reset_after="$CHATGPT_SPARK_PRIMARY_RESET_AFTER"
    other_lane_primary_reset_at="$CHATGPT_SPARK_PRIMARY_RESET_AT"
    other_lane_secondary_used="$CHATGPT_SPARK_SECONDARY_USED"
    other_lane_secondary_limit="$CHATGPT_SPARK_SECONDARY_LIMIT"
    other_lane_secondary_reset_after="$CHATGPT_SPARK_SECONDARY_RESET_AFTER"
    other_lane_secondary_reset_at="$CHATGPT_SPARK_SECONDARY_RESET_AT"
  fi

  other_lane_primary_quota_segment=""
  other_lane_secondary_quota_segment=""
  if [[ -n "$other_lane_primary_used" || -n "$other_lane_secondary_used" ]]; then
    qline=$(render_quota_line "$other_lane_primary_used" "$other_lane_primary_reset_after" "$other_lane_primary_reset_at")
    if [[ -n "$qline" ]]; then
      other_qtone="${qline%%$'\t'*}"
      other_rest="${qline#*$'\t'}"
      other_qtext="${other_rest%%$'\t'*}"
      other_qnote="${other_rest#*$'\t'}"
      other_qnote_disp="$other_qnote"
      if [[ -n "$other_qnote_disp" ]]; then
        printf -v other_qnote_disp "%b" "${DIM}${other_qnote_disp}${RESET}"
      fi
      other_lane_primary_quota_segment="$(colorize "$other_qtext" "$other_qtone")"
      if [[ -n "$other_qnote_disp" ]]; then
        other_lane_primary_quota_segment+=" ${other_qnote_disp}"
      fi
    fi

    qline=$(render_quota_line "$other_lane_secondary_used" "$other_lane_secondary_reset_after" "$other_lane_secondary_reset_at")
    if [[ -n "$qline" ]]; then
      other_qtone2="${qline%%$'\t'*}"
      other_rest2="${qline#*$'\t'}"
      other_qtext2="${other_rest2%%$'\t'*}"
      other_qnote2="${other_rest2#*$'\t'}"
      other_projection_note=""
      other_projection_alert=0
      other_projection_pct="$(project_quota_usage "$other_lane_secondary_used" "$other_lane_secondary_limit" "$other_lane_secondary_reset_after" || true)"
      if [[ -n "$other_projection_pct" ]]; then
        if (( other_projection_pct >= 100 )); then
          other_projection_note="proj 100% at reset"
          other_projection_alert=1
        else
          other_projection_note="proj ~${other_projection_pct}% at reset"
        fi
      fi
      other_qnote_full="$(join_with_semicolon "$other_qnote2" "$other_projection_note")"
      other_qnote2_disp="$other_qnote_full"
      if [[ -n "$other_qnote2_disp" ]]; then
        if (( other_projection_alert )); then
          printf -v other_qnote2_disp "%b" "${RED}${BOLD}${other_qnote2_disp}${RESET}"
        else
          printf -v other_qnote2_disp "%b" "${DIM}${other_qnote2_disp}${RESET}"
        fi
      fi
      other_lane_secondary_quota_segment="$(colorize "$other_qtext2" "$other_qtone2")"
      if [[ -n "$other_qnote2_disp" ]]; then
        other_lane_secondary_quota_segment+=" ${other_qnote2_disp}"
      fi
    fi
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
    projection_pct="$(project_quota_usage "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_LIMIT" "$CHATGPT_SECONDARY_RESET_AFTER" || true)"
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
        note_parts+=("allowance ${allowance_per_day}%/day")
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
    note3_disp=$(printf "%b" "${DIM}allowance ${allowance_per_day}%/day${RESET}")
    daily_quota_segment="$(colorize "$qtext3" "green") ${note3_disp}"
    daily_allowance_used_pct=0
  fi

  quota_warn_threshold=$(( quota_limit - 10 ))
  if (( quota_warn_threshold < 0 )); then
    quota_warn_threshold=0
  fi
  quota_reasons=()
  quota_warnings=()
  if [[ "$(lowercase "$CHATGPT_STATUS")" == "limit_reached" ]]; then
    quota_reasons+=("ChatGPT status limit_reached")
  fi
  if [[ "$CHATGPT_PRIMARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_PRIMARY_USED >= quota_limit )); then
      reason="${lane_prefix}5h quota reached (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_PRIMARY_USED >= quota_warn_threshold )); then
      reason="${lane_prefix}5h quota high (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_SECONDARY_USED >= quota_limit )); then
      reason="${lane_prefix}week quota reached (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_SECONDARY_USED >= quota_warn_threshold )); then
      reason="${lane_prefix}week quota high (${CHATGPT_SECONDARY_USED}% used"
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

  concurrent_compact_summary=0
  concurrent_compact_note=""
  concurrent_compact_tone="yellow"
  if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    concurrent_compact_summary=1
    if (( HAS_VALID_LOCAL_AUTH )); then
      concurrent_compact_note="Concurrent guard active; using local auth.json."
    elif (( HAS_LOCAL_AUTH )); then
      concurrent_compact_note="Concurrent guard active; local auth.json is invalid."
      concurrent_compact_tone="red"
    else
      concurrent_compact_note="Concurrent guard active; local auth.json is missing."
      concurrent_compact_tone="red"
    fi
  fi

  if (( ! wrapper_updated || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
    row_label_width_default="$ROW_LABEL_WIDTH"
    summary_row_labels=("Health" "Versions" "Usage" "Quota" "Result" "Concurrent" "Other lane")
    ROW_LABEL_WIDTH="$(compute_row_label_width "${summary_row_labels[@]}")"

    if (( CODEX_MINIMAL_OUTPUT )); then
      minimal_health_line="api=${api_tone} auth=${auth_tone} prompts=${prompt_tone} skills=${skill_tone} codex=${codex_tone} wrapper=${wrapper_tone}"
      if [[ -n "$agents_label" ]]; then
        minimal_health_line+=" agents=${agents_tone}"
      fi
      if [[ -n "$config_label" ]]; then
        minimal_health_line+=" config=${config_tone}"
      fi
      if (( QUOTA_BLOCKED )); then
        minimal_health_line+=" quota=blocked"
      elif (( QUOTA_WARNING )); then
        minimal_health_line+=" quota=warn"
      fi
      minimal_result_line="$result_label"
      if [[ "${HOST_VIP:-0}" == "1" ]]; then
        minimal_result_line+=" (vip)"
      fi
      log_info "$(format_simple_row "Health" "$minimal_health_line")"
      log_info "$(format_simple_row "Result" "$minimal_result_line")"
    else
      if (( concurrent_compact_summary )); then
        print_section_rows "Concurrent" "${bullet} $(colorize "$concurrent_compact_note" "$concurrent_compact_tone")"
      else
        print_section_rows "Health" "${health_rows[@]}"
        print_section_rows "Versions" "${version_rows[@]}"
        print_section_rows "Usage" "${usage_rows[@]}"
      fi

      quota_rows=()
      quota_metric_labels=("Active lane")
      if [[ -n "$primary_quota_segment" ]]; then
        quota_metric_labels+=("5h window")
      fi
      if [[ -n "$secondary_quota_segment" ]]; then
        quota_metric_labels+=("Weekly window")
      fi
      if [[ -n "$daily_quota_segment" ]] && (( QUOTA_WARNING || QUOTA_BLOCKED || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
        quota_metric_labels+=("Daily allowance")
      fi
      if [[ -n "$other_lane_primary_quota_segment" ]]; then
        quota_metric_labels+=("${other_lane_label} 5h window")
      fi
      if [[ -n "$other_lane_secondary_quota_segment" ]]; then
        quota_metric_labels+=("${other_lane_label} weekly window")
      fi
      quota_metric_label_width=0
      for quota_metric_label in "${quota_metric_labels[@]}"; do
        quota_metric_len=${#quota_metric_label}
        if (( quota_metric_len > quota_metric_label_width )); then
          quota_metric_label_width=$quota_metric_len
        fi
      done
      (( quota_metric_label_width < 12 )) && quota_metric_label_width=12
      QUOTA_METRIC_LABEL_WIDTH="$quota_metric_label_width"

      quota_rows+=("${bullet} $(format_quota_metric_row "Active lane" "${quota_lane_display}")")
      if [[ -n "$primary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "5h window" "${primary_quota_segment}")")
      fi
      if [[ -n "$secondary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "Weekly window" "${secondary_quota_segment}")")
      fi
      if [[ -n "$daily_quota_segment" ]] && (( QUOTA_WARNING || QUOTA_BLOCKED || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
        quota_rows+=("${bullet} $(format_quota_metric_row "Daily allowance" "${daily_quota_segment}")")
      fi
      if [[ -n "$other_lane_primary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "${other_lane_label} 5h window" "${other_lane_primary_quota_segment}")")
      fi
      if [[ -n "$other_lane_secondary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "${other_lane_label} weekly window" "${other_lane_secondary_quota_segment}")")
      fi
      if (( QUOTA_WARNING )) && [[ -n "$QUOTA_WARNING_REASON" ]]; then
        quota_rows+=("${bullet} $(colorize "Near limit: ${QUOTA_WARNING_REASON}" "yellow")")
      fi
      if (( QUOTA_BLOCKED )) && [[ -n "$QUOTA_BLOCK_REASON" ]]; then
        quota_rows+=("${bullet} $(colorize "Limit reached: ${QUOTA_BLOCK_REASON}" "red")")
      fi
      print_section_rows "Quota" "${quota_rows[@]}"

      if (( ! concurrent_compact_summary )); then
        print_section_rows "Result" "${bullet} ${result_line}"
      fi
    fi

    ROW_LABEL_WIDTH="$row_label_width_default"
  fi

if (( CODEX_DOCTOR_ONLY )); then
  print_doctor_report
  if (( DOCTOR_FAILURES > 0 )) || [[ "$result_tone" == "red" ]]; then
    release_run_lock_if_held || true
    exit 1
  fi
  release_run_lock_if_held || true
  exit 0
fi

if (( CODEX_STATUS_ONLY )); then
  if [[ "$result_tone" == "red" ]]; then
    release_run_lock_if_held || true
    exit 1
  fi
  release_run_lock_if_held || true
  exit 0
fi

if (( wrapper_updated )) && (( ! CODEX_EXIT_AFTER_UPDATE )) && (( ! CODEX_STATUS_ONLY )) && (( ! CODEX_DOCTOR_ONLY )); then
  if [[ "${CODEX_WRAPPER_RESTARTED:-0}" == "1" ]]; then
    release_run_lock_if_held || true
    log_error "Wrapper update loop detected; aborting."
    exit 1
  fi
  log_warn "Wrapper updated; restarting cdx to load the new wrapper."
  if ! declare -p CODEX_ORIGINAL_ARGS >/dev/null 2>&1; then
    CODEX_ORIGINAL_ARGS=()
  fi
  release_run_lock_if_held || true
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
  insecure-denied)
    AUTH_LAUNCH_REASON="Insecure host approval denied; re-run or open the host window."
    ;;
  concurrent)
    if (( HAS_VALID_LOCAL_AUTH )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="Active cdx run detected; using local auth.json with sync/update mutations skipped"
    elif (( HAS_LOCAL_AUTH )); then
      AUTH_LAUNCH_REASON="Active cdx run detected and local auth.json is invalid."
    else
      AUTH_LAUNCH_REASON="Active cdx run detected and no local auth.json is available."
    fi
    ;;
  fail)
    AUTH_LAUNCH_REASON="Auth sync failed; check API connectivity."
    ;;
  *)
    AUTH_LAUNCH_REASON="Auth unavailable; fix sync before retrying."
    ;;
esac

if (( AUTH_LAUNCH_ALLOWED == 1 )) && (( CODEX_LANE_WANTS_RUN )) && (( QUOTA_BLOCKED )); then
  if (( QUOTA_HARD_FAIL )); then
    AUTH_LAUNCH_ALLOWED=0
    AUTH_LAUNCH_REASON="${QUOTA_BLOCK_REASON:-ChatGPT quota reached}"
  else
    log_warn "ChatGPT quota reached: ${QUOTA_BLOCK_REASON:-see details above}. Continuing (warn mode)."
  fi
fi

if (( QUOTA_WARNING )) && (( AUTH_LAUNCH_ALLOWED == 1 )) && (( CODEX_LANE_WANTS_RUN )); then
  log_warn "ChatGPT quota near limit: ${QUOTA_WARNING_REASON:-see usage above}."
fi

if (( AUTH_LAUNCH_ALLOWED == 0 )); then
  release_run_lock_if_held || true
  log_error "${AUTH_LAUNCH_REASON:-Auth unavailable; refusing to start Codex. Re-run after fixing API key or provisioning auth.}"
  exit 1
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  log_warn "${AUTH_LAUNCH_REASON} (last_refresh ${ORIGINAL_LAST_REFRESH:-unknown})."
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  log_warn "${AUTH_LAUNCH_REASON}."
fi

if (( CODEX_LANE_PERSIST_REQUEST )); then
  if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    release_run_lock_if_held || true
    log_error "Cannot persist lane while another cdx run is active. Re-run with --allow-concurrent-sync if you want to override."
    exit 1
  fi
  lane_to_persist="$CODEX_LANE_TARGET"
  if [[ "$CODEX_LANE_CLEAR_REQUEST" == "1" ]]; then
    lane_to_persist=""
  fi
  if persist_lane_preference_with_api "$lane_to_persist"; then
    if [[ -n "$lane_to_persist" ]]; then
      log_info "Persisted host lane preference: ${lane_to_persist}"
    else
      log_info "Cleared host lane preference (host now follows inherited defaults)."
    fi
  else
    release_run_lock_if_held || true
    log_error "Failed to persist lane preference via /host/lane."
    exit 1
  fi
fi

if (( CODEX_LANE_COMMAND )); then
  lane_effective_display="${CODEX_EFFECTIVE_LANE:-normal}"
  lane_persisted_display="${HOST_LANE_PREFERENCE:-inherit}"
  lane_source_display="${CODEX_EFFECTIVE_LANE_SOURCE:-unknown}"
  if [[ "$lane_persisted_display" != "inherit" ]]; then
    lane_persisted_display="host:${lane_persisted_display}"
  fi
  log_info "Lane state | effective=${lane_effective_display} (${lane_source_display}) | persisted=${lane_persisted_display}"
  if (( CODEX_LANE_USER_SET )); then
    lane_request_line="Lane request | one-shot=${CODEX_LANE_TARGET}"
    if (( CODEX_LANE_PERSIST_REQUEST )); then
      lane_request_line+=", persisted"
    fi
    log_info "$lane_request_line"
  fi
fi

if (( CODEX_LANE_WANTS_RUN == 0 )); then
  release_run_lock_if_held || true
  exit 0
fi

cleanup() {
  local exit_status=$?
  trap - EXIT
  if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    AUTH_PUSH_RESULT="skipped"
    AUTH_PUSH_REASON="active cdx run"
  else
    push_slash_commands_if_changed || true
    push_skills_if_changed || true
    if (( CODEX_COMMAND_STARTED )) && (( SYNC_PUSH_COMPLETED == 0 )); then
      push_auth_if_changed "push" || true
    fi
  fi
  if (( PURGE_AUTH_AFTER_RUN )) && (( CODEX_COMMAND_STARTED )) && (( ! CDX_ACTIVE_RUN_DETECTED )) && [[ -f "$HOME/.codex/auth.json" ]]; then
    remove_path "$HOME/.codex/auth.json" "auth.json (insecure host)"
  fi
  print_run_exit_footer || true
  release_run_lock_if_held || true
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

codex_cli_args_from_config_python() {
  python3 - "$CONFIG_PATH" <<'PY'
import re, sys

path = sys.argv[1]
try:
    raw = open(path, "r", encoding="utf-8", errors="ignore").read()
except Exception:
    sys.exit(0)

def find_block(name: str) -> str:
    m = re.search(r'(?m)^\\[' + re.escape(name) + r'\\]\\s*$', raw)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r'(?m)^\\[', raw[start:])
    end = start + (m2.start() if m2 else len(raw[start:]))
    return raw[start:end]

block = find_block("security")
if not block:
    sys.exit(0)

m = re.search(r'(?m)^\\s*dangerously_bypass_approvals_and_sandbox\\s*=\\s*(true|false)\\s*$', block)
if m and m.group(1) == "true":
    print("--dangerously-bypass-approvals-and-sandbox")
PY
}

apply_codex_cli_toggles_from_config() {
  if [[ ! -f "$CONFIG_PATH" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
      --dangerously-bypass-approvals-and-sandbox)
        set -- "$line" "$@"
        ;;
    esac
  done < <(codex_cli_args_from_config_python 2>/dev/null || true)
}

apply_codex_cli_toggles_from_config

detect_script_flags() {
  local help_output
  SCRIPT_SUPPORTS_C=0
  help_output="$(script --help 2>&1 || script -h 2>&1 || true)"
  if printf '%s' "$help_output" | grep -Eq '(^|[[:space:]])-c([[:space:],]|$)'; then
    SCRIPT_SUPPORTS_C=1
  fi
  if printf '%s' "$help_output" | grep -Eq '(^|[[:space:]])-F([[:space:],]|$)'; then
    SCRIPT_FLAGS="-qFe"
  elif printf '%s' "$help_output" | grep -Eq '(^|[[:space:]])-f([[:space:],]|$)'; then
    SCRIPT_FLAGS="-qef"
  else
    SCRIPT_FLAGS="-qe"
  fi
}

run_codex_command() {
  local tmp_output status
  tmp_output="$(mktemp)"
  set +e
  local prompt_toolkit_no_cpr_added=0
  local pty_auto_disable_file="$HOME/.codex/.cdx_no_pty"
  local pty_tty_error=0
  # If we're not connected to a real TTY (common on some odd SSH/VM setups),
  # forcing prompt-toolkit cursor position reports can hard-fail.
  if [[ -z "${PROMPT_TOOLKIT_NO_CPR:-}" ]] && [[ ! -t 0 || ! -t 1 ]]; then
    export PROMPT_TOOLKIT_NO_CPR=1
    prompt_toolkit_no_cpr_added=1
  fi

  if [[ -t 0 && -t 1 ]]; then
    local cmd_line=("$CODEX_REAL_BIN" "$@")
    if [[ "$CODEX_NO_PTY" == "1" ]]; then
      # Preserve interactive TTY behavior when PTY capture is explicitly disabled.
      "${cmd_line[@]}"
      status=$?
    elif [[ "${CODEX_FORCE_PTY:-0}" != "1" && -f "$pty_auto_disable_file" ]]; then
      # Auto-detected incompatible PTY host; run direct unless explicitly overridden.
      "${cmd_line[@]}"
      status=$?
    else
      if [[ -z "${PROMPT_TOOLKIT_NO_CPR:-}" ]]; then
        export PROMPT_TOOLKIT_NO_CPR=1
        prompt_toolkit_no_cpr_added=1
      fi
      if [[ "$CODEX_NO_SCRIPT" != "1" ]] && command -v script >/dev/null 2>&1; then
        # Use script to keep a PTY and capture output to a typescript file while streaming to the real TTY.
        local cmd_str
        cmd_str="$(printf '%q ' "${cmd_line[@]}")"
        detect_script_flags
        if (( SCRIPT_SUPPORTS_C )); then
          script $SCRIPT_FLAGS "$tmp_output" -c "$cmd_str"
        else
          script $SCRIPT_FLAGS "$tmp_output" "${cmd_line[@]}"
        fi
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

      if [[ -f "$tmp_output" ]] && grep -Eiq '(stdout is not a terminal|stdin is not a terminal|stdin/stderr is not a TTY|stdin is not a tty|stdout is not a tty)' "$tmp_output"; then
        pty_tty_error=1
      fi
      # Only retry when the PTY run itself failed and looks TTY-incompatible.
      if (( pty_tty_error )) && [[ ${status:-1} -ne 0 ]]; then
        mkdir -p "$(dirname "$pty_auto_disable_file")" >/dev/null 2>&1 || true
        {
          printf 'detected_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          printf 'wrapper_version=%s\n' "${WRAPPER_VERSION:-unknown}"
        } > "$pty_auto_disable_file" 2>/dev/null || true
        log_warn "PTY capture looks incompatible on this host; auto-disabling PTY capture. Remove $pty_auto_disable_file or set CODEX_FORCE_PTY=1 to retry."
        "${cmd_line[@]}"
        status=$?
      fi
    fi
  else
    # Non-TTY stdout should not rewrite user intent (for example forcing `exec`).
    # For interactive no-arg launches, fail fast with an explicit non-interactive hint.
    if [[ ! -t 1 ]]; then
      if (( $# == 0 )); then
        log_error "stdout is not a TTY; interactive launch requires a terminal."
        log_error "Use: cdx --execute \"<prompt>\" [codex args...]"
        status=1
      else
        "$CODEX_REAL_BIN" "$@" 2>&1 | tee "$tmp_output"
        status=${PIPESTATUS[0]}
      fi
    else
      "$CODEX_REAL_BIN" "$@" 2>&1 | tee "$tmp_output"
      status=${PIPESTATUS[0]}
    fi
  fi
  if (( prompt_toolkit_no_cpr_added )); then
    unset PROMPT_TOOLKIT_NO_CPR
  fi
  set -e
  if [[ -f "$tmp_output" ]]; then
    send_token_usage_if_present "$tmp_output"
    rm -f "$tmp_output"
  fi
  return "$status"
}

codex_args_include_profile_or_model() {
  local arg=""
  for arg in "$@"; do
    case "$arg" in
      --model|--profile|--model=*|--profile=*)
        return 0
        ;;
    esac
  done
  return 1
}

user_selected_profile_or_model=0
if codex_args_include_profile_or_model "$@"; then
  user_selected_profile_or_model=1
fi
if [[ -n "${CODEX_PROFILE_CANDIDATE:-}" ]]; then
  user_selected_profile_or_model=1
fi

if [[ -n "${CODEX_PROFILE_CANDIDATE:-}" ]]; then
  candidate="$CODEX_PROFILE_CANDIDATE"
  CODEX_PROFILE_CANDIDATE=""
  if config_has_profile "$candidate"; then
    set -- --profile "$candidate" "$@"
  else
    set -- "$candidate" "$@"
  fi
fi

lane_selector_profile=""
lane_selector_model=""
CODEX_EFFECTIVE_LANE_SELECTOR=""
apply_lane_selector=0
if [[ "$CODEX_EFFECTIVE_LANE_SOURCE" == command* || "$CODEX_EFFECTIVE_LANE_SOURCE" == host* ]]; then
  apply_lane_selector=1
fi
if (( apply_lane_selector )) && [[ "$CODEX_EFFECTIVE_LANE" == "normal" || "$CODEX_EFFECTIVE_LANE" == "spark" ]]; then
  if config_has_profile "$CODEX_EFFECTIVE_LANE"; then
    lane_selector_profile="$CODEX_EFFECTIVE_LANE"
    CODEX_EFFECTIVE_LANE_SELECTOR="profile:${lane_selector_profile}"
  elif [[ "$CODEX_EFFECTIVE_LANE" == "spark" ]]; then
    lane_selector_model="gpt-5.3-codex-spark"
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${lane_selector_model}"
  else
    lane_selector_model="gpt-5.3-codex"
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${lane_selector_model}"
  fi
fi

if (( user_selected_profile_or_model )) && (( CODEX_LANE_USER_SET )); then
  log_warn "Lane override requested, but explicit --model/--profile args were provided; honoring explicit Codex args."
fi

injected_model=0
if (( ! user_selected_profile_or_model )) && [[ -n "$lane_selector_profile" ]]; then
  set -- --profile "$lane_selector_profile" "$@"
elif (( ! user_selected_profile_or_model )) && [[ -n "$lane_selector_model" ]]; then
  set -- --model "$lane_selector_model" "$@"
  injected_model=1
elif (( ! user_selected_profile_or_model )) && [[ -n "$CODEX_HOST_MODEL" ]]; then
  set -- --model "$CODEX_HOST_MODEL" "$@"
  injected_model=1
  if [[ -z "$CODEX_EFFECTIVE_LANE_SELECTOR" ]]; then
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${CODEX_HOST_MODEL}"
  fi
fi

if (( ! user_selected_profile_or_model )) && (( injected_model )) && [[ -n "$CODEX_HOST_REASONING_EFFORT" ]]; then
  set -- --config "model_reasoning_effort=${CODEX_HOST_REASONING_EFFORT}" "$@"
fi

CODEX_COMMAND_STARTED=1
if run_codex_command "$@"; then
  cmd_status=0
else
  cmd_status=$?
fi
if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
  AUTH_PUSH_RESULT="skipped"
  AUTH_PUSH_REASON="active cdx run"
else
  push_auth_if_changed "push" || true
fi
exit "$cmd_status"
