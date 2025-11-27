
API_RELEASES_URL="https://api.github.com/repos/openai/codex/releases"

SCRIPT_REAL="$(real_path "$0")"
CODEX_REAL_BIN="$(resolve_real_codex)"
if [[ -z "$CODEX_REAL_BIN" ]]; then
  log_error "Unable to find the real Codex binary on PATH"
  exit 1
fi

platform_os="$(uname -s 2>/dev/null || echo unknown)"
platform_arch="$(uname -m 2>/dev/null || echo unknown)"
print_motd

can_manage_codex=0
if (( IS_ROOT )); then
  can_manage_codex=1
elif (( CAN_SUDO )) && [[ "$CURRENT_USER" == "chris" ]]; then
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
ORIGINAL_LAST_REFRESH="$(get_auth_last_refresh "$HOME/.codex/auth.json")"
LOCAL_AUTH_IS_FRESH=0
if is_last_refresh_recent "$ORIGINAL_LAST_REFRESH" "$MAX_LOCAL_AUTH_AGE_SECONDS"; then
  LOCAL_AUTH_IS_FRESH=1
fi
HAS_LOCAL_AUTH=0
[[ -f "$HOME/.codex/auth.json" ]] && HAS_LOCAL_AUTH=1

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
          log_info "Unable to detect glibc version; using musl Codex build for compatibility."
        elif version_lt "$glibc_version" "2.39"; then
          asset_name="codex-x86_64-unknown-linux-musl.tar.gz"
          log_info "glibc ${glibc_version} detected; using musl Codex build for compatibility."
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
      if [[ "$(printf '%s\n%s\n' "$norm_local" "$norm_remote" | sort -V | tail -n1)" == "$norm_remote" ]]; then
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
  add_tag() { local t="$1"; [[ -z "$t" ]] && return; for existing in "${candidate_tags[@]}"; do [[ "$existing" == "$t" ]] && return; done; candidate_tags+=("$t"); }
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
      if [[ -n "$CODEX_SYNC_CA_FILE" ]]; then
        curl_args+=("--cacert" "$CODEX_SYNC_CA_FILE")
      fi
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
    red) printf "%b%s%b" "${RED}${BOLD}" "$text" "${RESET}" ;;
    *) printf "%s" "$text" ;;
  esac
}

ROW_LABEL_WIDTH=12
ROW_VALUE_WIDTH=32
QUOTA_BAR_WIDTH=24

format_status_row() {
  local label="$1" col1="$2" col2="$3" col3="$4"
  printf "%-${ROW_LABEL_WIDTH}s | %-${ROW_VALUE_WIDTH}s | %-${ROW_VALUE_WIDTH}s | %s" "$label" "$col1" "$col2" "$col3"
}

format_simple_row() {
  local label="$1" text="$2"
  printf "%-${ROW_LABEL_WIDTH}s | %s" "$label" "$text"
}

format_quota_row() {
  local label="$1" text="$2" note="$3"
  printf "%-${ROW_LABEL_WIDTH}s | %-${ROW_VALUE_WIDTH}s | %s" "$label" "$text" "$note"
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
    local filled=$(( (pct * width + 50) / 100 ))
    (( filled > width )) && filled=$width
    local bar_filled
    local bar_empty
    bar_filled=$(printf '%*s' "$filled" "" | tr ' ' '#')
    bar_empty=$(printf '%*s' $(( width - filled )) "" | tr ' ' '.')
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
      tone="yellow"
    else
      tone="green"
    fi

    text=$(printf "%3d%% [%s%s]" "$pct" "$bar_filled" "$bar_empty")
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
  printf "%d" "$projected"
}

format_auth_label() {
  local status="$1" action="$2" msg="$3"
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
    api_label="Unavailable (offline)"
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
esac

auth_label="n/a"
if [[ -n "$AUTH_STATUS" ]]; then
  auth_label="$(format_auth_label "$AUTH_STATUS" "$AUTH_ACTION" "$AUTH_MESSAGE")"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  cached_lr="${ORIGINAL_LAST_REFRESH:-unknown}"
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    auth_label="using cached auth (api offline; last_refresh ${cached_lr})"
  elif (( HAS_LOCAL_AUTH )); then
    auth_label="cached auth stale (api offline; last_refresh ${cached_lr})"
  else
    auth_label="auth unavailable (api offline)"
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
    auth_tone="yellow"
    ;;
  *)
    auth_tone="yellow"
    ;;
esac
if [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    auth_tone="yellow"
  else
    auth_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_tone="red"
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
elif [[ "$PROMPT_SYNC_STATUS" == "error" ]]; then
  prompt_label="sync failed"
  prompt_tone="red"
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

command_actions=()
if (( codex_update_attempted )); then command_actions+=("codex"); fi
if (( wrapper_update_attempted )); then command_actions+=("wrapper"); fi
if [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ || "$AUTH_ACTION" == "store" ]]; then command_actions+=("auth"); fi
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
  auth_result="auth ${AUTH_STATUS}"
  if [[ -n "$AUTH_ACTION" ]]; then
    auth_result+=", ${AUTH_ACTION}"
  fi
  result_parts+=("$auth_result")
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    result_parts+=("auth cached (api offline)")
  elif (( HAS_LOCAL_AUTH )); then
    result_parts+=("auth stale (api offline)")
  else
    result_parts+=("auth unavailable (api offline)")
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
elif [[ "$PROMPT_SYNC_STATUS" == "error" ]]; then
  result_parts+=("prompts sync failed")
fi
if [[ "$PROMPT_PUSH_STATUS" == "error" ]]; then
  result_parts+=("prompts push failed")
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
  if (( HAS_LOCAL_AUTH )); then
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

  log_info "$(format_status_row "codex" "$codex_installed_display" "$codex_target_display" "$(colorize "$codex_status_display" "$codex_tone")")"
  log_info "$(format_status_row "wrapper" "$wrapper_installed_display" "$wrapper_target_display" "$(colorize "$wrapper_status_display" "$wrapper_tone")")"
  log_info "$(format_simple_row "api" "$(colorize "$api_label" "$api_tone")")"
  log_info "$(format_simple_row "auth" "$(colorize "$auth_label" "$auth_tone")")"
  log_info "$(format_simple_row "prompts" "$(colorize "$prompt_label" "$prompt_tone")")"
  host_usage_parts=()
  if [[ -n "$HOST_API_CALLS" ]]; then
    host_usage_parts+=("api calls ${HOST_API_CALLS}")
  fi
  if [[ -n "$HOST_TOKENS_MONTH_TOTAL" ]]; then
    token_bits=()
    [[ -n "$HOST_TOKENS_MONTH_TOTAL" ]] && token_bits+=("total ${HOST_TOKENS_MONTH_TOTAL}")
    [[ -n "$HOST_TOKENS_MONTH_INPUT" ]] && token_bits+=("in ${HOST_TOKENS_MONTH_INPUT}")
    [[ -n "$HOST_TOKENS_MONTH_OUTPUT" ]] && token_bits+=("out ${HOST_TOKENS_MONTH_OUTPUT}")
    [[ -n "$HOST_TOKENS_MONTH_CACHED" ]] && token_bits+=("cached ${HOST_TOKENS_MONTH_CACHED}")
    [[ -n "$HOST_TOKENS_MONTH_REASONING" ]] && token_bits+=("reason ${HOST_TOKENS_MONTH_REASONING}")
    token_line="$(join_with_semicolon "${token_bits[@]}")"
    host_usage_parts+=("tokens this month: ${token_line}")
  fi
  if (( ${#host_usage_parts[@]} )); then
    host_usage_text="$(join_with_semicolon "${host_usage_parts[@]}")"
    log_info "$(format_simple_row "host usage" "$host_usage_text")"
  fi
  primary_reset_hint=""
  qline=$(render_quota_line "$CHATGPT_PRIMARY_USED" "$CHATGPT_PRIMARY_RESET_AFTER" "$CHATGPT_PRIMARY_RESET_AT")
  if [[ -n "$qline" ]]; then
    qtone="${qline%%$'\t'*}"
    rest="${qline#*$'\t'}"
    qtext="${rest%%$'\t'*}"
    qnote="${rest#*$'\t'}"
    primary_reset_hint="$qnote"
    log_info "$(format_quota_row "5h quota" "$(colorize "$qtext" "$qtone")" "$(colorize "$qnote" "$qtone")")"
  fi

  secondary_reset_hint=""
  qline=$(render_quota_line "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_RESET_AFTER" "$CHATGPT_SECONDARY_RESET_AT")
  if [[ -n "$qline" ]]; then
    qtone2="${qline%%$'\t'*}"
    rest2="${qline#*$'\t'}"
    qtext2="${rest2%%$'\t'*}"
    qnote2="${rest2#*$'\t'}"
    projection_note=""
    projection_pct="$(project_quota_usage "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_LIMIT" "$CHATGPT_SECONDARY_RESET_AFTER")"
    if [[ -n "$projection_pct" ]]; then
      projection_note="proj ~${projection_pct}% at reset"
    fi
    qnote_full="$(join_with_semicolon "$qnote2" "$projection_note")"
    secondary_reset_hint="$qnote_full"
    log_info "$(format_quota_row "week quota" "$(colorize "$qtext2" "$qtone2")" "$(colorize "$qnote_full" "$qtone2")")"
  fi

  quota_reasons=()
  quota_warnings=()
  if [[ "${CHATGPT_STATUS,,}" == "limit_reached" ]]; then
    quota_reasons+=("ChatGPT status limit_reached")
  fi
  if [[ "$CHATGPT_PRIMARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_PRIMARY_USED >= 100 )); then
      reason="5h quota reached (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_PRIMARY_USED >= 90 )); then
      reason="5h quota high (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_SECONDARY_USED >= 100 )); then
      reason="week quota reached (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_SECONDARY_USED >= 90 )); then
      reason="week quota high (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
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

  if (( QUOTA_HARD_FAIL )); then
    log_info "ChatGPT quota policy: deny launch when quota is reached."
  else
    log_info "ChatGPT quota policy: warn only; continue even if quota is reached."
  fi
  if (( QUOTA_BLOCKED )); then
    log_warn "ChatGPT quota status: ${QUOTA_BLOCK_REASON:-limit reached}."
  fi

  if [[ -n "$usage_summary" ]]; then
    log_info "$(format_simple_row "tokens" "$usage_summary")"
  fi
  log_info "$(format_simple_row "result" "$(colorize "$result_label" "$result_tone")")"
  log_info "$(format_simple_row "command" "$(colorize "$command_label" "$command_tone")")"

if (( wrapper_updated )); then
  log_warn "Wrapper updated; restart cdx to use the new wrapper."
  exit 0
fi

AUTH_LAUNCH_ALLOWED=0
AUTH_LAUNCH_REASON=""
case "$AUTH_PULL_STATUS" in
  ok)
    AUTH_LAUNCH_ALLOWED=1
    ;;
  offline)
    if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="API offline; using cached auth.json"
    elif (( HAS_LOCAL_AUTH )); then
      AUTH_LAUNCH_REASON="API offline; cached auth.json older than 24h"
    else
      AUTH_LAUNCH_REASON="API offline and no cached auth.json"
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
  if (( CODEX_COMMAND_STARTED )) && (( SYNC_PUSH_COMPLETED == 0 )); then
    push_auth_if_changed "push" || true
  fi
  # Emit final auth push status if determined
  if [[ -n "$AUTH_PUSH_RESULT" ]]; then
    log_info "Auth push | ${AUTH_PUSH_RESULT} | ${AUTH_PUSH_REASON:-n/a}"
  fi
  exit "$exit_status"
}
trap cleanup EXIT

if (( AUTH_LAUNCH_ALLOWED == 0 )); then
  exit 1
fi

run_codex_command() {
  local tmp_output status
  tmp_output="$(mktemp)"
  set +e
  if [[ -t 1 && "$CODEX_NO_PTY" != "1" ]]; then
    local cmd_line=("$CODEX_REAL_BIN" --ask-for-approval never --sandbox danger-full-access "$@")
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
    "$CODEX_REAL_BIN" --ask-for-approval never --sandbox danger-full-access "$@" 2>&1 | tee "$tmp_output"
    status=${PIPESTATUS[0]}
  fi
  set -e
  if [[ -f "$tmp_output" ]]; then
    send_token_usage_if_present "$tmp_output"
    rm -f "$tmp_output"
  fi
  return "$status"
}

CODEX_COMMAND_STARTED=1
if run_codex_command "$@"; then
  cmd_status=0
else
  cmd_status=$?
fi
push_auth_if_changed "push" || true
exit "$cmd_status"
