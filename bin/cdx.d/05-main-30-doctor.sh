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
path = sys.argv[1]
method = 'heuristic'
try:
    import tomllib
    method = 'tomllib'
except ImportError:
    try:
        import tomli as tomllib
        method = 'tomllib'
    except ImportError:
        tomllib = None
if tomllib is not None:
    try:
        with open(path, 'rb') as fh:
            tomllib.load(fh)
        print('ok:' + method)
    except Exception as e:
        print(str(e))
        sys.exit(1)
else:
    try:
        content = open(path, 'r').read()
        for line in content.splitlines():
            stripped = line.strip()
            if stripped.startswith('#') or not stripped:
                continue
            if stripped.startswith('['):
                # Strip inline comment before checking: [section] # comment is valid TOML.
                header_part = stripped.split('#')[0].rstrip()
                if not header_part.endswith(']'):
                    print('unclosed table header: ' + stripped)
                    sys.exit(1)
        print('ok:' + method)
    except Exception as e:
        print(str(e))
        sys.exit(1)
" "$CONFIG_PATH" 2>&1)" || config_parse_err="parse error"
    if [[ "$config_parse_err" == ok:* ]]; then
      local toml_method="${config_parse_err#ok:}"
      config_validity_label="valid (${toml_method}) ✅"
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

  local cron_label="n/a"
  if command -v crontab >/dev/null 2>&1; then
    local cdx_real_path=""
    cdx_real_path="$(real_path "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")"
    local cron_marker=""
    cron_marker="$(cron_managed_marker)"
    local current_crontab=""
    current_crontab="$(crontab -l 2>/dev/null || true)"
    local quoted_cdx_path=""
    printf -v quoted_cdx_path '%q' "$cdx_real_path"
    if cron_has_wrapper_entry "$current_crontab" "$cdx_real_path" "$quoted_cdx_path" "$cron_marker"; then
      cron_label="installed ✅"
    else
      if [[ "${SYNC_REMOTE_AUTO_UPDATE_CRON:-}" == "1" ]]; then
        cron_label="$(colorize "not installed (server expects cron)" "yellow")"
        hints+=("Auto-update cron is expected by the server but not installed. Run: cdx --cron install")
      else
        cron_label="not installed"
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
    "wrapper=${WRAPPER_VERSION}"
  )
  local boot_elapsed=""
  boot_elapsed="$(cdx_elapsed_ms "$CDX_BOOT_START_NS")"
  if [[ -n "$boot_elapsed" ]]; then
    cli_bits+=("boot=${boot_elapsed}ms")
  fi
  if (( CODEX_SSH_INTERACTIVE )); then
    if [[ "${CODEX_FORCE_PTY:-0}" == "1" ]]; then
      cli_bits+=("ssh-launch=pty-forced")
    else
      cli_bits+=("ssh-launch=direct-tty")
    fi
  fi

  local doctor_row_labels=("Deps" "Paths" "Auth" "Sync" "Config" "MCP" "API" "Latency" "Disk" "Cron" "PTY" "SSH env" "CLI")
  local saved_row_label_width="$ROW_LABEL_WIDTH"
  ROW_LABEL_WIDTH="$(compute_row_label_width "${doctor_row_labels[@]}")"

  log_info "$(summary_divider)"
  log_info "$(summary_header "Doctor report")"
  log_info "$(format_simple_row "Deps" "$(join_with_sep ' | ' "${dep_bits[@]}")")"
  log_info "$(format_simple_row "Paths" "codex=${CODEX_REAL_BIN}; wrapper=${SCRIPT_REAL}")"
  log_info "$(format_simple_row "Auth" "freshness=${auth_freshness}; status=${AUTH_PULL_STATUS:-unknown}")"
  log_info "$(format_simple_row "Sync" "$sync_label")"
  log_info "$(format_simple_row "Config" "path=${CONFIG_PATH}; state=${config_state_label}; validity=${config_validity_label}")"
  log_info "$(format_simple_row "MCP" "$mcp_label")"
  log_info "$(format_simple_row "API" "$api_probe_label")"
  if [[ -n "$api_latency_label" ]]; then
    log_info "$(format_simple_row "Latency" "$api_latency_label")"
  fi
  log_info "$(format_simple_row "Disk" "$disk_label")"
  log_info "$(format_simple_row "Cron" "$cron_label")"
  log_info "$(format_simple_row "PTY" "$pty_label")"
  log_info "$(format_simple_row "SSH env" "$ssh_env_label")"
  log_info "$(format_simple_row "CLI" "$(join_with_sep '; ' "${cli_bits[@]}")")"

  local result_summary=""
  if (( failures == 0 )); then
    result_summary="$(colorize "all checks passed" "green") ✅"
  elif (( failures == 1 )); then
    result_summary="$(colorize "1 failure" "red") — see hints below"
  else
    result_summary="$(colorize "${failures} failures" "red") — see hints below"
  fi
  log_info "$(format_simple_row "Result" "$result_summary")"

  if (( ${#hints[@]} )); then
    log_info "$(summary_divider)"
    local hint_index=1
    local hint
    for hint in "${hints[@]}"; do
      log_warn "$(format_simple_row "Hint ${hint_index}" "$hint")"
      hint_index=$(( hint_index + 1 ))
    done
  fi

  ROW_LABEL_WIDTH="$saved_row_label_width"
  DOCTOR_FAILURES=$failures
}
