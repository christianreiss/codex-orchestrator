API_RELEASES_URL="https://api.github.com/repos/openai/codex/releases"

if ((CODEX_CRON_MODE)); then
  if ((CODEX_CRON_INSTALL)); then
    install_cron_job
    exit $?
  fi

  if ((CODEX_CRON_REMOVE)); then
    remove_cron_job
    exit $?
  fi

  cron_auto_update
  exit $?
fi

SCRIPT_REAL="$(real_path "$0")"
CODEX_REAL_BIN="$(resolve_real_codex)"
if [[ -z "$CODEX_REAL_BIN" ]]; then
  log_error "Unable to find the real Codex binary on PATH"
  exit 1
fi

# Help invocations should behave exactly like upstream Codex help output.
if ((!CODEX_STATUS_ONLY)) && ((!CODEX_DOCTOR_ONLY)) && ((!CODEX_DO_UNINSTALL)) && ((!CODEX_LANE_COMMAND)) && ((!CODEX_EXIT_AFTER_UPDATE)) && is_codex_help_passthrough_invocation "$@"; then
  exec "$CODEX_REAL_BIN" "$@"
fi

platform_os="$(uname -s 2>/dev/null || echo unknown)"
platform_arch="$(uname -m 2>/dev/null || echo unknown)"

can_manage_codex=0
if ((IS_ROOT)); then
  can_manage_codex=1
elif ((CAN_SUDO)); then
  can_manage_codex=1
fi

if [[ "$platform_os" == "Linux" ]]; then
  if ((can_manage_codex)); then
    if ((CODEX_EXIT_AFTER_UPDATE)); then
      ensure_commands curl
    else
      ensure_commands curl unzip
      ensure_commands python3
      ensure_optional_commands bwrap
    fi
  fi
elif [[ "$platform_os" == "Darwin" ]]; then
  if ((CODEX_EXIT_AFTER_UPDATE)); then
    ensure_commands curl
  else
    ensure_commands curl unzip
    ensure_commands python3
  fi
fi

LOCAL_VERSION_RAW="$("$CODEX_REAL_BIN" -V 2>/dev/null || true)"
LOCAL_VERSION="$(normalize_version "$LOCAL_VERSION_RAW")"
LOCAL_VERSION_UNKNOWN=0
if [[ -z "$LOCAL_VERSION" ]]; then
  LOCAL_VERSION_UNKNOWN=1
  log_warn "Could not determine local Codex version; attempting to refresh Codex before launch."
fi

CODEX_SSH_SESSION_ACTIVE=0
CODEX_SSH_INTERACTIVE=0
CODEX_SSH_PTY_BRIDGE_ACTIVE=0
if is_ssh_session; then
  CODEX_SSH_SESSION_ACTIVE=1
  if [[ -t 0 && -t 1 ]]; then
    CODEX_SSH_INTERACTIVE=1
    if command -v python3 >/dev/null 2>&1; then
      CODEX_SSH_PTY_BRIDGE_ACTIVE=1
    fi
  fi
fi

# Guard mutating sync/update work when another cdx run is already active.
if ((!CODEX_CONCURRENT_SYNC_OVERRIDE)); then
  acquire_run_lock_or_mark_concurrent || true
fi
if ((CDX_ACTIVE_RUN_DETECTED)); then
  concurrent_reason="${CDX_ACTIVE_RUN_INFO:-active cdx run detected}"
  AUTH_PULL_STATUS="concurrent"
  AUTH_PULL_REASON="$concurrent_reason"
  SKILL_SYNC_STATUS="mcp"
  SKILL_SYNC_REASON=""
  AGENTS_SYNC_STATUS="skip"
  AGENTS_SYNC_REASON="active-run"
  CONFIG_SYNC_STATUS="skip"
  CONFIG_SYNC_REASON="active-run"
  # Keep concurrent mode non-mutating for pre-run sync/update work, but refresh quota/policy metadata.
  load_sync_config
  if command -v python3 >/dev/null 2>&1 && [[ -n "$CODEX_SYNC_API_KEY" && -n "$CODEX_SYNC_BASE_URL" ]]; then
    sync_auth_with_api "pull-readonly" "1" || true
    AUTH_PULL_STATUS="concurrent"
    AUTH_PULL_REASON="$concurrent_reason"
  fi
else
  cleanup_legacy_prompt_state || true
  sync_skills_pull || true
  if startup_bundle_can_include_auth "$HOME/.codex/auth.json"; then
    _t_bundle="$(cdx_time_ms)"
    if ! sync_startup_bundle_pull; then
      if [[ "$STARTUP_BUNDLE_SYNC_STATUS" == "endpoint-missing" ]]; then
        _t_auth="$(cdx_time_ms)"
        sync_auth_with_api "pull" || true
        cdx_debug_phase "auth-sync" "$_t_auth"
        sync_agents_pull || true
        sync_config_pull || true
      elif [[ "$STARTUP_BUNDLE_SYNC_STATUS" != "offline" ]]; then
        _t_auth="$(cdx_time_ms)"
        sync_auth_with_api "pull" || true
        cdx_debug_phase "auth-sync" "$_t_auth"
      fi
    fi
    cdx_debug_phase "bundle-sync" "$_t_bundle"
  else
    # Early auth + versions sync (single POST), captures target versions and hydrates auth if needed.
    _t_auth="$(cdx_time_ms)"
    sync_auth_with_api "pull" || true
    cdx_debug_phase "auth-sync" "$_t_auth"
    _t_bundle="$(cdx_time_ms)"
    if ! sync_startup_bundle_pull; then
      if [[ "$STARTUP_BUNDLE_SYNC_STATUS" == "endpoint-missing" ]]; then
        sync_agents_pull || true
        sync_config_pull || true
      fi
    fi
    cdx_debug_phase "bundle-sync" "$_t_bundle"
  fi
fi
ORIGINAL_LAST_REFRESH="$(get_auth_last_refresh "$HOME/.codex/auth.json")"
ORIGINAL_AUTH_SHA="$(sha256_file "$HOME/.codex/auth.json" 2>/dev/null || true)"
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
if ((HAS_LOCAL_AUTH)) && validate_auth_json_file "$HOME/.codex/auth.json"; then
  HAS_VALID_LOCAL_AUTH=1
fi

# Banner rendering is deferred to the display phase (print_boot_screen)
# so that version/status info can be shown alongside the ASCII art.

AUTO_UPDATE_CRON_READY=0
if ((!CDX_ACTIVE_RUN_DETECTED)) && ((!CODEX_CRON_MODE)) && ((!CODEX_DO_UNINSTALL)); then
  if [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]]; then
    if reconcile_cron_job_state install; then
      AUTO_UPDATE_CRON_READY=1
    else
      log_warn "Cron-managed auto-update is enabled by the server, but the wrapper could not ensure the cron job; falling back to startup Codex update checks."
    fi
  else
    reconcile_cron_job_state remove || log_warn "Server disabled cron-managed auto-update, but the wrapper could not remove the managed cron job."
  fi
fi

asset_name=""
skip_update_check=0
skip_update_reason=""
if ((CDX_ACTIVE_RUN_DETECTED)); then
  skip_update_check=1
  skip_update_reason="active_run"
elif [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]] && ((AUTO_UPDATE_CRON_READY)); then
  skip_update_check=1
  skip_update_reason="cron_managed"
elif ((!can_manage_codex)); then
  skip_update_check=1
  skip_update_reason="privilege"
fi

if ((!skip_update_check)); then
  asset_name="$(detect_codex_asset_name 2>/dev/null)" || true
  if [[ -z "$asset_name" ]]; then
    os_name="$(uname -s 2>/dev/null || echo unknown)"
    arch_name="$(uname -m 2>/dev/null || echo unknown)"
    log_warn "Unsupported platform (${os_name}/${arch_name}); skipping update check."
    skip_update_check=1
    skip_update_reason="unsupported_platform"
  fi
fi

remote_version=""
remote_url=""
remote_asset=""
remote_tag=""
remote_source=""
remote_timestamp=0
prefer_npm_update=0
enforce_exact_codex_version=0

case "$(lowercase "${SYNC_REMOTE_CLIENT_VERSION_ENFORCE_EXACT:-}")" in
  1 | true | yes)
    enforce_exact_codex_version=1
    ;;
  0 | false | no)
    enforce_exact_codex_version=0
    ;;
  *)
    if [[ "${SYNC_REMOTE_CLIENT_VERSION_SOURCE:-}" == "locked" ]]; then
      enforce_exact_codex_version=1
    fi
    ;;
esac

if ((!skip_update_check)); then
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
if ((!skip_update_check)) && [[ -n "$remote_version" ]]; then
  norm_remote="$(normalize_version "$remote_version")"
  if ((LOCAL_VERSION_UNKNOWN)); then
    need_update=1
  else
    norm_local="$(normalize_version "$LOCAL_VERSION")"
    if [[ "$norm_remote" != "$norm_local" ]]; then
      if ((enforce_exact_codex_version)); then
        need_update=1
      elif version_lt "$norm_local" "$norm_remote"; then
        need_update=1
      fi
    fi
  fi
fi

defer_codex_update_for_wrapper=0
if ((need_update)) && ((!CODEX_EXIT_AFTER_UPDATE)) && ((!CODEX_STATUS_ONLY)) && ((!CODEX_DOCTOR_ONLY)) \
  && ((!CDX_ACTIVE_RUN_DETECTED)) && [[ "$AUTH_PULL_STATUS" == "ok" ]] && [[ "${CODEX_WRAPPER_RESTARTED:-0}" != "1" ]]; then
  precheck_target_wrapper="${SYNC_REMOTE_WRAPPER_VERSION:-${WRAPPER_VERSION}}"
  precheck_target_wrapper_url="$(resolve_wrapper_target_url "${SYNC_REMOTE_WRAPPER_URL:-}")"
  if [[ -n "$precheck_target_wrapper" && "$precheck_target_wrapper" != "$WRAPPER_VERSION" &&
    -n "$precheck_target_wrapper_url" && -n "$CODEX_SYNC_API_KEY" ]]; then
    defer_codex_update_for_wrapper=1
    log_info "Wrapper update to ${precheck_target_wrapper} pending; deferring Codex update until wrapper restart."
  fi
fi

if ((need_update)) && is_codex_installed_via_npm; then
  prefer_npm_update=1
fi

# If an update is needed but we don't yet have a download URL (e.g., version came from the API), fetch release metadata now.
if ((need_update)) && ((defer_codex_update_for_wrapper == 0)) && [[ -z "$remote_url" ]] && require_python; then
  tmp_payload="$(mktemp)"
  fetch_success=0
  candidate_tags=()
  add_tag() {
    local t="$1"
    [[ -z "$t" ]] && return
    for existing in "${candidate_tags[@]-}"; do [[ "$existing" == "$t" ]] && return; done
    candidate_tags+=("$t")
  }
  add_tag "$remote_tag"
  add_tag "$remote_version"
  add_tag "v${remote_version}"
  add_tag "rust-${remote_version}"
  add_tag "rust-v${remote_version}"

  for tag_variant in "${candidate_tags[@]}"; do
    if payload_json="$(fetch_release_payload "${API_RELEASES_URL}/tags/${tag_variant}" "$asset_name" 2>/dev/null)"; then
      printf '%s\n' "$payload_json" >"$tmp_payload"
      fresh_fields=()
      if payload_raw="$(read_cached_payload "$tmp_payload")"; then
        while IFS= read -r line; do
          fresh_fields+=("$line")
        done <<<"$payload_raw"
      fi
      if ((${#fresh_fields[@]} >= 5)); then
        remote_version="${fresh_fields[0]}"
        remote_url="${fresh_fields[1]}"
        remote_asset="${fresh_fields[2]}"
        remote_timestamp="${fresh_fields[3]}"
        remote_tag="${fresh_fields[4]}"
        remote_sha256="${fresh_fields[5]:-}"
        fetch_success=1
        break
      fi
    fi
  done
  rm -f "$tmp_payload"
  if ((fetch_success == 0)); then
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

if ((skip_update_check)); then
  codex_target_label="${remote_version:-${LOCAL_VERSION:-unknown}}"
  codex_status_label="Check skipped"
  case "$skip_update_reason" in
    active_run)
      codex_status_note="active cdx run"
      ;;
    cron_managed)
      codex_status_note="cron-managed updates"
      ;;
    unsupported_platform)
      codex_status_note="unsupported platform (${platform_os}/${platform_arch})"
      ;;
    *)
      codex_status_note="not permitted to manage Codex (need root; uid ${DETECTED_UID:-unknown})"
      ;;
  esac
elif ((need_update)) && ((defer_codex_update_for_wrapper)); then
  codex_target_label="${norm_remote:-${remote_version:-unknown}}"
  codex_status_label="Deferred"
  codex_status_note="waiting for wrapper restart"
elif ((need_update)) && [[ -n "$remote_url" ]]; then
  display_local="${LOCAL_VERSION:-unknown}"
  codex_target_label="$norm_remote"
  codex_update_attempted=1
  if ((prefer_npm_update)) && update_codex_via_npm "$norm_remote"; then
    hash -r
    CODEX_REAL_BIN="$(resolve_real_codex)"
    LOCAL_VERSION_RAW="$("$CODEX_REAL_BIN" -V 2>/dev/null || true)"
    LOCAL_VERSION="$(normalize_version "$LOCAL_VERSION_RAW")"
    LOCAL_VERSION_UNKNOWN=0
    codex_updated=1
    codex_status_label="Updated"
    codex_status_note="npm codex-cli @${norm_remote}"
  elif [[ -z "${remote_sha256:-}" ]]; then
    codex_update_failed=1
    codex_status_label="Update skipped"
    codex_status_note="checksum missing"
    log_warn "Codex update skipped: missing trusted checksum for ${norm_remote}"
  elif perform_update "$CODEX_REAL_BIN" "$remote_url" "${remote_asset:-$asset_name}" "$norm_remote" "$remote_sha256"; then
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

if ((!CDX_ACTIVE_RUN_DETECTED)) && { [[ "$AUTH_PULL_STATUS" == "ok" || "$CODEX_FORCE_WRAPPER_UPDATE" == "1" ]]; }; then
  target_wrapper="${SYNC_REMOTE_WRAPPER_VERSION:-${WRAPPER_VERSION}}"
  target_wrapper_sha="${SYNC_REMOTE_WRAPPER_SHA256:-}"
  target_wrapper_url="$(resolve_wrapper_target_url "${SYNC_REMOTE_WRAPPER_URL:-}")"
  wrapper_target_label="${target_wrapper:-$WRAPPER_VERSION}"

  need_wrapper_update=0
  if wrapper_self_update_needed "$target_wrapper" "$target_wrapper_sha"; then
    need_wrapper_update=1
  fi
  if ((CODEX_FORCE_WRAPPER_UPDATE)) && [[ "${CODEX_UPDATE_CONTINUE_AFTER_RESTART:-0}" != "1" ]]; then
    need_wrapper_update=1
    wrapper_status_note="forced update requested"
  fi

  if ((need_wrapper_update)) && [[ -n "$target_wrapper_url" ]]; then
    wrapper_update_attempted=1
    if [[ -z "$CODEX_SYNC_API_KEY" ]]; then
      log_warn "Wrapper update skipped: API key missing"
      wrapper_update_failed=1
      wrapper_status_label="Update skipped"
      wrapper_status_note="API key missing"
    else
      if perform_wrapper_self_update "$target_wrapper" "$target_wrapper_sha" "$target_wrapper_url"; then
        wrapper_state="updated (${WRAPPER_VERSION})"
        wrapper_updated=1
        wrapper_status_label="Updated"
        if [[ "$WRAPPER_VERSION_INITIAL" != "$WRAPPER_VERSION" ]]; then
          wrapper_status_note="${wrapper_status_note:-from ${WRAPPER_VERSION_INITIAL}}"
        fi
      else
        log_warn "Wrapper update failed: ${WRAPPER_UPDATE_LAST_ERROR:-unknown}"
        wrapper_update_failed=1
        wrapper_status_label="Update failed"
        wrapper_status_note="${WRAPPER_UPDATE_LAST_ERROR:-unknown}"
      fi
    fi
  elif ((need_wrapper_update)) && [[ -z "$target_wrapper_url" ]]; then
    log_warn "Wrapper update skipped: API did not provide download URL"
    wrapper_update_failed=1
    wrapper_status_label="Update skipped"
    wrapper_status_note="missing download URL"
  fi
elif ((CDX_ACTIVE_RUN_DETECTED)); then
  wrapper_status_label="Check skipped"
  wrapper_status_note="active cdx run"
fi

if ((CODEX_EXIT_AFTER_UPDATE)); then
  if ((wrapper_updated)) && [[ "${CODEX_WRAPPER_RESTARTED:-0}" != "1" ]]; then
    if ! declare -p CODEX_ORIGINAL_ARGC >/dev/null 2>&1 || [[ ! "${CODEX_ORIGINAL_ARGC:-}" =~ ^[0-9]+$ ]]; then
      CODEX_ORIGINAL_ARGC=0
    fi
    if ! declare -p CODEX_ORIGINAL_ARGS >/dev/null 2>&1; then
      CODEX_ORIGINAL_ARGS=()
    fi
    release_run_lock_if_held || true
    log_info "Wrapper update completed (version ${WRAPPER_VERSION}); restarting cdx --update to finish Codex checks."
    if ((CODEX_ORIGINAL_ARGC > 0)); then
      CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 CODEX_UPDATE_CONTINUE_AFTER_RESTART=1 exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"
    fi
    CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 CODEX_UPDATE_CONTINUE_AFTER_RESTART=1 exec "$SCRIPT_REAL"
  fi

  release_run_lock_if_held || true
  if ((wrapper_update_failed)) || ((codex_update_failed)); then
    if ((wrapper_update_failed)) && ((codex_update_failed)); then
      log_error "Wrapper update failed (${wrapper_status_note:-unknown}); Codex update failed (${codex_status_note:-unknown})."
    elif ((wrapper_update_failed)); then
      log_error "Wrapper update failed (${wrapper_status_note:-unknown})."
    else
      log_error "Codex update failed (${codex_status_note:-unknown})."
    fi
    exit 1
  fi
  if ((wrapper_updated)) && ((codex_updated)); then
    log_info "Wrapper and Codex updates completed (wrapper ${WRAPPER_VERSION}; Codex ${LOCAL_VERSION:-unknown})."
    exit 0
  fi
  if ((wrapper_updated)); then
    log_info "Wrapper update completed (version ${WRAPPER_VERSION})."
    exit 0
  fi
  if ((codex_updated)); then
    log_info "Codex update completed (version ${LOCAL_VERSION:-unknown})."
    exit 0
  fi
  if [[ "$(lowercase "$wrapper_status_label")" == "current" ]] && [[ "$(lowercase "$codex_status_label")" == "current" ]]; then
    log_info "Wrapper and Codex are already current."
    exit 0
  fi
  log_warn "Update check ended without changes (wrapper: ${wrapper_status_label}; Codex: ${codex_status_label})."
  exit 1
fi
