
API_RELEASES_URL="https://api.github.com/repos/openai/codex/releases"

SCRIPT_REAL="$(real_path "$0")"
CODEX_REAL_BIN="$(resolve_real_codex)"
if [[ -z "$CODEX_REAL_BIN" ]]; then
  log_error "Unable to find the real Codex binary on PATH"
  exit 1
fi

# Help invocations should behave exactly like upstream Codex help output.
if (( ! CODEX_STATUS_ONLY )) && (( ! CODEX_DOCTOR_ONLY )) && (( ! CODEX_DO_UNINSTALL )) && (( ! CODEX_LANE_COMMAND )) && (( ! CODEX_EXIT_AFTER_UPDATE )) && is_codex_help_passthrough_invocation "$@"; then
  exec "$CODEX_REAL_BIN" "$@"
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
    log_warn "${concurrent_reason}; skipping pre-run sync/update mutations for this run. Post-run auth/usage upload still runs. Use --allow-concurrent-sync to override."
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
  # Keep concurrent mode non-mutating for pre-run sync/update work, but refresh quota/policy metadata.
  load_sync_config
  if command -v python3 >/dev/null 2>&1 && [[ -n "$CODEX_SYNC_API_KEY" && -n "$CODEX_SYNC_BASE_URL" ]]; then
    sync_auth_with_api "pull-readonly" "1" || true
    AUTH_PULL_STATUS="concurrent"
    AUTH_PULL_REASON="$concurrent_reason"
  fi
else
  # Early auth + versions sync (single POST), captures target versions and hydrates auth if needed.
  sync_auth_with_api "pull" || true
  if ! sync_startup_bundle_pull; then
    sync_slash_commands_pull || true
    sync_skills_pull || true
    sync_agents_pull || true
    sync_config_pull || true
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
        remote_sha256="${fresh_fields[5]:-}"
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
