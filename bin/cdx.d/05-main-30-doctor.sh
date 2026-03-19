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
  local api_probe_start_ns=""
  local api_probe_end_ns=""
  local api_probe_elapsed_ms=""
  api_probe_start_ns="$(date +%s%N 2>/dev/null || true)"
  if api_probe="$(doctor_probe_api_versions)"; then
    api_probe_rc=0
  else
    api_probe_rc=$?
  fi
  api_probe_end_ns="$(date +%s%N 2>/dev/null || true)"
  if [[ "$api_probe_start_ns" =~ ^[0-9]+$ ]] && [[ "$api_probe_end_ns" =~ ^[0-9]+$ ]]; then
    api_probe_elapsed_ms=$(( (api_probe_end_ns - api_probe_start_ns) / 1000000 ))
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

  local ssh_session_label="local"
  if (( CODEX_SSH_SESSION_ACTIVE )); then
    ssh_session_label="ssh"
    if (( CODEX_SSH_INTERACTIVE )); then
      ssh_session_label+=" interactive"
    else
      ssh_session_label+=" non-interactive"
    fi
  fi
  local ssh_bits=(
    "session=${ssh_session_label}"
    "TERM=${TERM:-unknown}"
    "TERM_PROGRAM=${TERM_PROGRAM:-n/a}"
    "KONSOLE_VERSION=${KONSOLE_VERSION:-n/a}"
    "VTE_VERSION=${VTE_VERSION:-n/a}"
    "KITTY_WINDOW_ID=${KITTY_WINDOW_ID:+set}"
    "WEZTERM_VERSION=${WEZTERM_VERSION:-n/a}"
    "WT_SESSION=${WT_SESSION:+set}"
  )
  local ssh_env_label
  ssh_env_label="$(join_with_sep '; ' "${ssh_bits[@]}")"

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

  local mcp_label="n/a"
  if [[ -f "$CONFIG_PATH" ]]; then
    if toml_table_enabled "$CONFIG_PATH" "mcp_servers.cdx"; then
      mcp_label="configured ✅"
    elif toml_table_enabled "$CONFIG_PATH" "mcp_servers.codex-orchestrator"; then
      mcp_label="configured (legacy name) ✅"
    else
      mcp_label="$(colorize "not configured or disabled" "yellow")"
      hints+=("MCP server [mcp_servers.cdx] is missing or disabled in config.toml.")
    fi
  else
    mcp_label="$(colorize "no config.toml" "yellow")"
  fi

  local config_validity_label="n/a"
  if [[ -f "$CONFIG_PATH" ]] && command -v python3 >/dev/null 2>&1; then
    local config_parse_err=""
    config_parse_err="$(python3 -c "
import sys
try:
    content = open(sys.argv[1], 'r').read()
    # Minimal TOML validation: check for unclosed brackets and basic structure
    bracket_depth = 0
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith('#') or not stripped:
            continue
        if stripped.startswith('['):
            if not stripped.endswith(']'):
                print('unclosed table header: ' + stripped)
                sys.exit(1)
    print('ok')
except Exception as e:
    print(str(e))
    sys.exit(1)
" "$CONFIG_PATH" 2>&1)" || config_parse_err="parse error"
    if [[ "$config_parse_err" == "ok" ]]; then
      config_validity_label="valid ✅"
    else
      config_validity_label="$(colorize "parse error: ${config_parse_err}" "red")"
      failures=$(( failures + 1 ))
      hints+=("config.toml has parse errors; fix or re-sync the file.")
    fi
  elif [[ -f "$CONFIG_PATH" ]]; then
    config_validity_label="$(colorize "python3 required for validation" "yellow")"
  fi

  local disk_label="ok"
  local codex_parent="${HOME}/.codex"
  if command -v df >/dev/null 2>&1 && [[ -d "$codex_parent" ]]; then
    local free_kb=""
    free_kb="$(df -Pk "$codex_parent" 2>/dev/null | awk 'NR==2 {print $4}')" || free_kb=""
    if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
      local free_mb=$(( free_kb / 1024 ))
      if (( free_mb < 500 )); then
        disk_label="$(colorize "${free_mb}MB free (< 500MB)" "red")"
        failures=$(( failures + 1 ))
        hints+=("Disk space on ~/.codex partition is critically low (${free_mb}MB free).")
      elif (( free_mb < 1000 )); then
        disk_label="$(colorize "${free_mb}MB free" "yellow")"
        hints+=("Disk space on ~/.codex partition is low (${free_mb}MB free).")
      else
        disk_label="${free_mb}MB free ✅"
      fi
    fi
  fi

  local api_latency_label=""
  if [[ "$api_probe_elapsed_ms" =~ ^[0-9]+$ ]]; then
    if (( api_probe_elapsed_ms > 5000 )); then
      api_latency_label="$(colorize "${api_probe_elapsed_ms}ms (slow)" "red")"
      hints+=("API probe latency is high (${api_probe_elapsed_ms}ms); check network conditions.")
    elif (( api_probe_elapsed_ms > 2000 )); then
      api_latency_label="$(colorize "${api_probe_elapsed_ms}ms" "yellow")"
    else
      api_latency_label="${api_probe_elapsed_ms}ms ✅"
    fi
  fi

  local cli_bits=(
    "version=${LOCAL_VERSION:-unknown}"
  )
  if (( CODEX_SSH_INTERACTIVE )); then
    if [[ "${CODEX_FORCE_PTY:-0}" == "1" ]]; then
      cli_bits+=("ssh-launch=pty-forced")
    else
      cli_bits+=("ssh-launch=direct-tty")
    fi
  fi

  log_info "$(format_simple_row "Doctor deps" "$(join_with_sep ' | ' "${dep_bits[@]}")")"
  log_info "$(format_simple_row "Doctor paths" "codex=${CODEX_REAL_BIN}; wrapper=${SCRIPT_REAL}")"
  log_info "$(format_simple_row "Doctor auth" "freshness=${auth_freshness}; status=${AUTH_PULL_STATUS:-unknown}")"
  log_info "$(format_simple_row "Doctor sync" "$sync_label")"
  log_info "$(format_simple_row "Doctor cfg" "path=${CONFIG_PATH}; state=${config_state_label}; validity=${config_validity_label}")"
  log_info "$(format_simple_row "Doctor mcp" "$mcp_label")"
  log_info "$(format_simple_row "Doctor api" "$api_probe_label")"
  if [[ -n "$api_latency_label" ]]; then
    log_info "$(format_simple_row "Doctor lat" "$api_latency_label")"
  fi
  log_info "$(format_simple_row "Doctor disk" "$disk_label")"
  log_info "$(format_simple_row "Doctor pty" "$pty_label")"
  log_info "$(format_simple_row "Doctor ssh" "$ssh_env_label")"
  log_info "$(format_simple_row "Doctor cli" "$(join_with_sep '; ' "${cli_bits[@]}")")"

  if (( ${#hints[@]} )); then
    local hint
    for hint in "${hints[@]}"; do
      log_warn "Doctor hint: ${hint}"
    done
  fi

  DOCTOR_FAILURES=$failures
}
