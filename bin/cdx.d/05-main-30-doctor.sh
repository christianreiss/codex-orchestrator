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
      hints+=("Another cdx process is active; this run skips pre-run sync/update mutations unless --allow-concurrent-sync is passed.")
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

