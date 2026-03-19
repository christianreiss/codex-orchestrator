if (( wrapper_updated )) && (( ! CODEX_EXIT_AFTER_UPDATE )) && (( ! CODEX_STATUS_ONLY )) && (( ! CODEX_DOCTOR_ONLY )); then
  if [[ "${CODEX_WRAPPER_RESTARTED:-0}" == "1" ]]; then
    release_run_lock_if_held || true
    log_error "Wrapper update loop detected; aborting."
    exit 1
  fi
  log_warn "Wrapper updated; restarting cdx to load the new wrapper."
  if ! declare -p CODEX_ORIGINAL_ARGC >/dev/null 2>&1 || [[ ! "${CODEX_ORIGINAL_ARGC:-}" =~ ^[0-9]+$ ]]; then
    CODEX_ORIGINAL_ARGC=0
  fi
  if ! declare -p CODEX_ORIGINAL_ARGS >/dev/null 2>&1; then
    CODEX_ORIGINAL_ARGS=()
  fi
  release_run_lock_if_held || true
  if (( CODEX_ORIGINAL_ARGC > 0 )); then
    CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"
  fi
  CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "$SCRIPT_REAL"
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
