# ── CLX Bootstrap ─────────────────────────────────────────────
# Orchestrates the full startup: deps, auth, config, then launch.

CLX_LOCK_FILE="${CLX_DATA_DIR}/.clx.lock"

clx_acquire_lock() {
  if [[ -f "$CLX_LOCK_FILE" ]]; then
    local lock_pid=""
    lock_pid="$(cat "$CLX_LOCK_FILE" 2>/dev/null || true)"
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      CLX_ACTIVE_RUN_DETECTED=1
      if ((CLAUDE_CONCURRENT_SYNC_OVERRIDE)); then
        log_warn "Another CLX instance is running (PID ${lock_pid}); proceeding with --allow-concurrent-sync."
      else
        # Allow boot to continue (auth sync may return concurrent status),
        # but do not take the lock.
        log_debug "Another CLX instance is running (PID ${lock_pid}); concurrent mode."
        return 0
      fi
    fi
    rm -f "$CLX_LOCK_FILE"
  fi
  printf '%s' "$$" > "$CLX_LOCK_FILE"
  trap 'rm -f "$CLX_LOCK_FILE"' EXIT
}

clx_bootstrap() {
  local phase_start

  # Dependencies.
  phase_start="$(clx_time_ms)"
  ensure_deps
  clx_debug_phase "deps" "$phase_start"

  # Atomic startup bundle (gated by CLX_USE_STARTUP_BUNDLE). When it succeeds
  # we skip the three legacy per-phase syncs. When it fails for any reason
  # other than "disabled", we log the reason and fall through to the legacy
  # path so the host never misses a sync because the optimization flaked.
  local bundle_ok=0
  if clx_startup_bundle_enabled; then
    phase_start="$(clx_time_ms)"
    if clx_startup_bundle_pull; then
      bundle_ok=1
      log_debug "Startup bundle completed OK; skipping per-phase syncs."
    else
      log_debug "Startup bundle fell back (reason=${CLX_STARTUP_BUNDLE_STATUS})."
    fi
    clx_debug_phase "startup-bundle" "$phase_start"
  fi

  if (( bundle_ok == 0 )); then
    # Auth sync.
    phase_start="$(clx_time_ms)"
    clx_auth_sync
    clx_debug_phase "auth-sync" "$phase_start"

    # CLAUDE.md sync.
    phase_start="$(clx_time_ms)"
    clx_sync_agents
    clx_debug_phase "agents-sync" "$phase_start"

    # Config sync.
    phase_start="$(clx_time_ms)"
    clx_sync_config
    clx_debug_phase "config-sync" "$phase_start"
  fi

  # Skills sync always runs separately — it's a cheap listing call.
  phase_start="$(clx_time_ms)"
  clx_sync_skills
  clx_debug_phase "skills-sync" "$phase_start"

  # Apply model override (reads the just-synced settings.json).
  clx_apply_model_override

  # Check for wrapper updates (non-blocking).
  clx_check_wrapper_update &
  local update_pid=$!
  wait "$update_pid" 2>/dev/null || true
}

clx_status() {
  local claude_cli=""
  claude_cli="$(detect_claude_cli || true)"
  local claude_version=""
  if [[ -n "$claude_cli" ]]; then
    claude_version="$("$claude_cli" --version 2>/dev/null || echo "unknown")"
  fi

  local auth_fresh="unknown"
  if [[ -f "$CLX_AUTH_LAST_SYNC" ]]; then
    local ts now
    ts="$(cat "$CLX_AUTH_LAST_SYNC" 2>/dev/null || echo 0)"
    now="$(date +%s)"
    local age=$(( now - ts ))
    if (( age < CLX_AUTH_CACHE_TTL )); then
      auth_fresh="fresh (${age}s)"
    elif (( age < CLX_AUTH_FALLBACK_TTL )); then
      auth_fresh="stale but within fallback window (${age}s)"
    else
      auth_fresh="stale (${age}s)"
    fi
  fi

  local wrapper_source="seed"
  if [[ -n "${CLX_WRAPPER_SOURCE:-}" ]]; then
    wrapper_source="$CLX_WRAPPER_SOURCE"
  fi

  local auto_update="${CLX_AUTO_UPDATE_ENABLED:-1}"
  local bundle_state="${CLX_STARTUP_BUNDLE_STATUS:-not_attempted}"

  printf "%b%s%b Claude Code Status\n" "${VIOLET}${BOLD}" "" "${RESET}"
  printf "  Engine:            claude\n"
  printf "  Wrapper:           clx %s (%s)\n" "${WRAPPER_VERSION:-unknown}" "$wrapper_source"
  printf "  Auto-update:       %s\n" "$([[ "$auto_update" == "1" ]] && echo "enabled" || echo "disabled")"
  printf "  CLI:               %s\n" "${claude_version:-not installed}"
  printf "  FQDN:              %s\n" "${CLAUDE_SYNC_FQDN:-not configured}"
  printf "  Secure:            %s\n" "${CLAUDE_HOST_SECURE:-unknown}"
  printf "  Sync URL:          %s\n" "${CLAUDE_SYNC_BASE_URL:-not configured}"
  printf "  Startup bundle:    %s\n" "$bundle_state"
  printf "  Auth:              %s\n" "$([[ -f "$CLX_AUTH_FILE" ]] && echo "present" || echo "missing")"
  printf "  Auth freshness:    %s\n" "$auth_fresh"
  printf "  Config:            %s\n" "$([[ -f "$CLX_SETTINGS_FILE" ]] && echo "present" || echo "missing")"
  printf "  CLAUDE.md:         %s\n" "$([[ -f "$CLX_AGENTS_FILE" ]] && echo "present" || echo "missing")"
  if [[ -n "${CLAUDE_HOST_MODEL:-}" ]] && [[ "$CLAUDE_HOST_MODEL" != "__CLAUDE_HOST_MODEL__" ]]; then
    printf "  Model override:    %s\n" "$CLAUDE_HOST_MODEL"
  fi
  if [[ -n "${CLX_CLAUDE_FLEET_VERSION:-}" ]]; then
    printf "  Fleet version:     %s\n" "$CLX_CLAUDE_FLEET_VERSION"
  fi
  if [[ -n "${CLX_RUNNER_STATE:-}" ]]; then
    printf "  Runner state:      %s\n" "$CLX_RUNNER_STATE"
  fi
}

clx_doctor() {
  print_doctor_report
}
