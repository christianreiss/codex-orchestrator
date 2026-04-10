# ── CLX Doctor Diagnostic Report ──────────────────────────────
# Comprehensive diagnostic matching the CDX doctor output format,
# adapted for Claude Code / CLX paths and tooling.
# Uses shared functions from prolog: colorize, format_simple_row,
# summary_divider, summary_header, join_with_sep,
# compute_row_label_width, colorize_sync_status, output_supports_unicode.

# ── API probe ─────────────────────────────────────────────────

doctor_probe_api_versions() {
  if [[ -z "${CLAUDE_SYNC_BASE_URL:-}" ]]; then
    printf "fail\tmissing base url"
    return 1
  fi

  local http_code="" tmp_resp
  tmp_resp="$(mktemp)"

  http_code=$(clx_curl -o "$tmp_resp" -w '%{http_code}' \
    "${CLAUDE_SYNC_BASE_URL%/}/versions" 2>/dev/null) || true

  if [[ "$http_code" == "200" ]]; then
    local wrapper_ver=""
    wrapper_ver="$(jq -r '.wrapper_version // .data.wrapper_version // empty' "$tmp_resp" 2>/dev/null || true)"
    rm -f "$tmp_resp"
    if [[ -n "$wrapper_ver" ]]; then
      printf "ok\thttp 200; wrapper %s" "$wrapper_ver"
    else
      printf "ok\thttp 200"
    fi
    return 0
  fi

  rm -f "$tmp_resp"

  if [[ -n "$http_code" ]] && [[ "$http_code" != "000" ]]; then
    printf "fail\thttp %s" "$http_code"
  else
    printf "fail\tunreachable"
  fi
  return 1
}

# ── Doctor report ─────────────────────────────────────────────

DOCTOR_FAILURES=0

print_doctor_report() {
  local failures=0
  local hints=()

  # ── 1. Dependencies ──────────────────────────────────────────
  local dep_python="missing" dep_curl="missing" dep_jq="missing" dep_node="missing"
  command -v python3 >/dev/null 2>&1 && dep_python="ok"
  command -v curl >/dev/null 2>&1 && dep_curl="ok"
  command -v jq >/dev/null 2>&1 && dep_jq="ok"
  { command -v node >/dev/null 2>&1 || command -v nodejs >/dev/null 2>&1; } && dep_node="ok"

  local dep_bits=()
  if [[ "$dep_python" == "ok" ]]; then
    dep_bits+=("python3 ok")
  else
    dep_bits+=("python3 $(colorize "missing" "red")")
    failures=$((failures + 1))
    hints+=("Install python3; several checks require it.")
  fi
  if [[ "$dep_curl" == "ok" ]]; then
    dep_bits+=("curl ok")
  else
    dep_bits+=("curl $(colorize "missing" "yellow")")
    hints+=("Install curl to enable wrapper/CLI download updates.")
  fi
  if [[ "$dep_jq" == "ok" ]]; then
    dep_bits+=("jq ok")
  else
    dep_bits+=("jq $(colorize "missing" "red")")
    failures=$((failures + 1))
    hints+=("Install jq; CLX requires it for JSON processing.")
  fi
  if [[ "$dep_node" == "ok" ]]; then
    dep_bits+=("node ok")
  else
    dep_bits+=("node $(colorize "missing" "red")")
    failures=$((failures + 1))
    hints+=("Install Node.js (>= 18); Claude Code requires it.")
  fi

  # ── 2. Paths ─────────────────────────────────────────────────
  local claude_real_bin=""
  claude_real_bin="$(detect_claude_cli 2>/dev/null || true)"
  local script_real=""
  script_real="$(realpath "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")"

  # ── 3. Auth freshness ───────────────────────────────────────
  local auth_freshness=""
  if ((HAS_LOCAL_AUTH)); then
    if ((LOCAL_AUTH_IS_FRESH)); then
      auth_freshness="fresh (${ORIGINAL_LAST_REFRESH:-unknown})"
    elif ((HOST_IS_SECURE)) && ((${LOCAL_AUTH_IS_RECENT:-0})); then
      auth_freshness="recent secure-cache (${ORIGINAL_LAST_REFRESH:-unknown})"
    else
      auth_freshness="$(colorize "stale" "yellow") (${ORIGINAL_LAST_REFRESH:-unknown})"
      hints+=("Refresh auth soon; cached credentials are older than the normal window.")
    fi
  else
    auth_freshness="$(colorize "missing" "red")"
    failures=$((failures + 1))
    hints+=("No local auth credentials; check API connectivity and host registration.")
  fi

  # ── 4. Sync statuses ────────────────────────────────────────
  local sync_bits=(
    "auth=$(colorize_sync_status "${AUTH_PULL_STATUS:-unknown}")"
    "skills=$(colorize_sync_status "${SKILL_SYNC_STATUS:-unknown}")"
    "agents=$(colorize_sync_status "${AGENTS_SYNC_STATUS:-unknown}")"
    "config=$(colorize_sync_status "${CONFIG_SYNC_STATUS:-unknown}")"
  )
  local sync_label
  sync_label="$(join_with_sep ' | ' "${sync_bits[@]}")"
  case "$AUTH_PULL_STATUS" in
    invalid)
      failures=$((failures + 1))
      hints+=("API key rejected. Download a fresh wrapper or rotate the host key in admin.")
      ;;
    missing-config)
      failures=$((failures + 1))
      hints+=("Wrapper is missing baked sync config. Reinstall clx from /install token.")
      ;;
    insecure)
      failures=$((failures + 1))
      hints+=("Insecure host window is closed. Enable the host window in admin.")
      ;;
    insecure-denied)
      failures=$((failures + 1))
      hints+=("Host approval was denied. Approve/re-enable the host in admin and retry.")
      ;;
    offline)
      hints+=("API is offline; cached auth may work temporarily but sync/push is limited.")
      ;;
    concurrent)
      hints+=("Another clx process is active; this run skips pre-run sync/update mutations unless --allow-concurrent-sync is passed.")
      ;;
  esac

  # ── 5. Config (settings.json) ────────────────────────────────
  local settings_path="${HOME}/.claude/settings.json"
  local config_state_label=""
  if [[ -f "$settings_path" ]]; then
    config_state_label="${CONFIG_SYNC_STATUS:-unknown}"
    [[ -n "${CONFIG_STATE:-}" ]] && config_state_label+=" (${CONFIG_STATE})"
  elif [[ -f "${CLX_SETTINGS_FILE:-}" ]]; then
    config_state_label="present (clx cache only)"
    settings_path="$CLX_SETTINGS_FILE"
  else
    config_state_label="missing local file"
    if [[ "${CONFIG_SYNC_STATUS:-}" != "ok" ]]; then
      hints+=("settings.json is missing locally; restore API connectivity and rerun sync.")
    fi
  fi

  local config_validity_label="n/a"
  if [[ -f "$settings_path" ]] && command -v python3 >/dev/null 2>&1; then
    local config_parse_err=""
    config_parse_err="$(python3 -c "
import json, sys
try:
    json.load(open(sys.argv[1]))
    print('ok')
except Exception as e:
    print(str(e))
    sys.exit(1)
" "$settings_path" 2>&1)" || config_parse_err="parse error"
    if [[ "$config_parse_err" == "ok" ]]; then
      config_validity_label="valid (json) ok"
    else
      config_validity_label="$(colorize "parse error: ${config_parse_err}" "red")"
      failures=$((failures + 1))
      hints+=("settings.json has parse errors; fix or re-sync the file.")
    fi
  elif [[ -f "$settings_path" ]] && command -v jq >/dev/null 2>&1; then
    if jq empty "$settings_path" 2>/dev/null; then
      config_validity_label="valid (jq) ok"
    else
      config_validity_label="$(colorize "parse error" "red")"
      failures=$((failures + 1))
      hints+=("settings.json has parse errors; fix or re-sync the file.")
    fi
  elif [[ -f "$settings_path" ]]; then
    config_validity_label="$(colorize "python3/jq required for validation" "yellow")"
  fi

  # ── 6. MCP ───────────────────────────────────────────────────
  local mcp_label="n/a"
  if [[ -f "$settings_path" ]] && command -v jq >/dev/null 2>&1; then
    local has_clx_mcp="" has_legacy_mcp=""
    has_clx_mcp="$(jq -e '.mcpServers.clx // empty' "$settings_path" 2>/dev/null && echo "yes" || true)"
    has_legacy_mcp="$(jq -e '.mcpServers["codex-orchestrator"] // empty' "$settings_path" 2>/dev/null && echo "yes" || true)"
    if [[ "$has_clx_mcp" == "yes" ]]; then
      mcp_label="configured (clx) ok"
    elif [[ "$has_legacy_mcp" == "yes" ]]; then
      mcp_label="configured (legacy name) ok"
    else
      mcp_label="$(colorize "not configured" "yellow")"
      hints+=("MCP server 'clx' is missing in settings.json mcpServers.")
    fi
  elif [[ -f "$settings_path" ]]; then
    mcp_label="$(colorize "jq required to check" "yellow")"
  else
    mcp_label="$(colorize "no settings.json" "yellow")"
  fi

  # ── 7. API probe ─────────────────────────────────────────────
  local api_probe="fail\tunreachable"
  local api_probe_rc=1
  local api_probe_start_ns="" api_probe_end_ns="" api_probe_elapsed_ms=""
  api_probe_start_ns="$(clx_time_ms)"
  if api_probe="$(doctor_probe_api_versions)"; then
    api_probe_rc=0
  else
    api_probe_rc=$?
  fi
  api_probe_end_ns="$(clx_time_ms)"
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
      failures=$((failures + 1))
      hints+=("Check ${CLAUDE_SYNC_BASE_URL%/}/versions reachability, DNS/TLS, firewall, and CA settings.")
      ;;
  esac

  # ── 8. Runner ────────────────────────────────────────────────
  local runner_row_label=""
  local runner_row_tone="yellow"
  if ((${runner_enabled_flag:-0})) || [[ -n "${runner_label:-}" ]]; then
    runner_row_label="${runner_label:-enabled; no verification data yet}"
    runner_row_tone="${runner_tone:-yellow}"
    if [[ "$runner_row_tone" == "red" ]]; then
      failures=$((failures + 1))
      hints+=("Runner is failing. Check the runner service and review admin event logs.")
    fi
  fi

  # ── 9. Disk ──────────────────────────────────────────────────
  local disk_label="ok"
  local claude_parent="${HOME}/.claude"
  if command -v df >/dev/null 2>&1 && [[ -d "$claude_parent" ]]; then
    local free_kb=""
    free_kb="$(df -Pk "$claude_parent" 2>/dev/null | awk 'NR==2 {print $4}')" || free_kb=""
    if [[ "$free_kb" =~ ^[0-9]+$ ]]; then
      local free_mb=$((free_kb / 1024))
      if ((free_mb < 500)); then
        disk_label="$(colorize "${free_mb}MB free (< 500MB)" "red")"
        failures=$((failures + 1))
        hints+=("Disk space on ~/.claude partition is critically low (${free_mb}MB free).")
      elif ((free_mb < 1000)); then
        disk_label="$(colorize "${free_mb}MB free" "yellow")"
        hints+=("Disk space on ~/.claude partition is low (${free_mb}MB free).")
      else
        disk_label="${free_mb}MB free ok"
      fi
    fi
  fi

  # ── 10. Cron ─────────────────────────────────────────────────
  local cron_label="n/a"
  if command -v crontab >/dev/null 2>&1; then
    if cron_wrapper_entry_installed; then
      cron_label="installed ok"
    else
      cron_label="not installed"
    fi
  fi

  # ── 11. SSH env ──────────────────────────────────────────────
  local ssh_session_label="local"
  if [[ -n "${SSH_CONNECTION:-}" ]] || [[ -n "${SSH_CLIENT:-}" ]]; then
    ssh_session_label="ssh"
    if [[ -t 0 ]]; then
      ssh_session_label+=" interactive"
    else
      ssh_session_label+=" non-interactive"
    fi
  fi
  local ssh_bits=(
    "session=${ssh_session_label}"
    "TERM=${TERM:-unknown}"
  )
  [[ -n "${TERM_PROGRAM:-}" ]] && ssh_bits+=("TERM_PROGRAM=${TERM_PROGRAM}")
  [[ -n "${KONSOLE_VERSION:-}" ]] && ssh_bits+=("KONSOLE_VERSION=${KONSOLE_VERSION}")
  [[ -n "${VTE_VERSION:-}" ]] && ssh_bits+=("VTE_VERSION=${VTE_VERSION}")
  [[ -n "${KITTY_WINDOW_ID:-}" ]] && ssh_bits+=("KITTY_WINDOW_ID=set")
  [[ -n "${WEZTERM_VERSION:-}" ]] && ssh_bits+=("WEZTERM_VERSION=${WEZTERM_VERSION}")
  [[ -n "${WT_SESSION:-}" ]] && ssh_bits+=("WT_SESSION=set")
  local ssh_env_label
  ssh_env_label="$(join_with_sep '; ' "${ssh_bits[@]}")"

  # ── 12. CLI info ─────────────────────────────────────────────
  local local_version="unknown"
  if [[ -n "$claude_real_bin" ]]; then
    local_version="$("$claude_real_bin" --version 2>/dev/null || echo "unknown")"
  fi
  local cli_bits=(
    "version=${local_version}"
    "wrapper=${WRAPPER_VERSION:-unknown}"
  )
  local boot_elapsed=""
  boot_elapsed="$(clx_elapsed_ms "$CLX_BOOT_START_NS")"
  if [[ -n "$boot_elapsed" ]]; then
    cli_bits+=("boot=${boot_elapsed}ms")
  fi

  # ── API latency ──────────────────────────────────────────────
  local api_latency_label=""
  if [[ "${api_probe_elapsed_ms:-}" =~ ^[0-9]+$ ]]; then
    if ((api_probe_elapsed_ms > 5000)); then
      api_latency_label="$(colorize "${api_probe_elapsed_ms}ms (slow)" "red")"
      hints+=("API probe latency is high (${api_probe_elapsed_ms}ms); check network conditions.")
    elif ((api_probe_elapsed_ms > 2000)); then
      api_latency_label="$(colorize "${api_probe_elapsed_ms}ms" "yellow")"
    else
      api_latency_label="${api_probe_elapsed_ms}ms ok"
    fi
  fi

  # ── Render ───────────────────────────────────────────────────
  local doctor_row_labels=("Deps" "Paths" "Auth" "Sync" "Config" "MCP" "Runner" "API" "Latency" "Disk" "Cron" "SSH env" "CLI")
  local saved_row_label_width="$ROW_LABEL_WIDTH"
  ROW_LABEL_WIDTH="$(compute_row_label_width "${doctor_row_labels[@]}")"

  log_info "$(summary_divider)"
  log_info "$(summary_header "Doctor report")"
  log_info "$(format_simple_row "Deps" "$(join_with_sep ' | ' "${dep_bits[@]}")")"
  log_info "$(format_simple_row "Paths" "claude=${claude_real_bin:-not found}; wrapper=${script_real}")"
  log_info "$(format_simple_row "Auth" "freshness=${auth_freshness}; status=${AUTH_PULL_STATUS:-unknown}")"
  log_info "$(format_simple_row "Sync" "$sync_label")"
  log_info "$(format_simple_row "Config" "path=${settings_path}; state=${config_state_label}; validity=${config_validity_label}")"
  log_info "$(format_simple_row "MCP" "$mcp_label")"
  if [[ -n "$runner_row_label" ]]; then
    local runner_row_display
    if [[ "$runner_row_tone" == "green" ]]; then
      runner_row_display="${runner_row_label} ok"
    else
      runner_row_display="$(colorize "$runner_row_label" "$runner_row_tone")"
    fi
    log_info "$(format_simple_row "Runner" "$runner_row_display")"
  fi
  log_info "$(format_simple_row "API" "$api_probe_label")"
  if [[ -n "$api_latency_label" ]]; then
    log_info "$(format_simple_row "Latency" "$api_latency_label")"
  fi
  log_info "$(format_simple_row "Disk" "$disk_label")"
  log_info "$(format_simple_row "Cron" "$cron_label")"
  log_info "$(format_simple_row "SSH env" "$ssh_env_label")"
  log_info "$(format_simple_row "CLI" "$(join_with_sep '; ' "${cli_bits[@]}")")"

  local result_summary=""
  local hints_suffix=""
  if ((${#hints[@]} > 0)); then
    hints_suffix=" -- see hints below"
  fi
  if ((failures == 0)); then
    result_summary="$(colorize "all checks passed" "green") ok"
  elif ((failures == 1)); then
    result_summary="$(colorize "1 failure" "red")${hints_suffix}"
  else
    result_summary="$(colorize "${failures} failures" "red")${hints_suffix}"
  fi
  log_info "$(format_simple_row "Result" "$result_summary")"

  if ((${#hints[@]})); then
    log_info "$(summary_divider)"
    local hint_index=1
    local hint
    for hint in "${hints[@]}"; do
      log_warn "$(format_simple_row "Hint ${hint_index}" "$hint")"
      hint_index=$((hint_index + 1))
    done
  fi
  log_info "$(summary_divider)"

  ROW_LABEL_WIDTH="$saved_row_label_width"
  DOCTOR_FAILURES=$failures
}
