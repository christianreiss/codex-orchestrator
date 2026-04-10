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

  # Auth sync.
  phase_start="$(clx_time_ms)"
  clx_auth_sync
  clx_debug_phase "auth-sync" "$phase_start"

  # CLAUDE.md sync.
  phase_start="$(clx_time_ms)"
  clx_sync_agents
  clx_debug_phase "agents-sync" "$phase_start"

  # Skills sync.
  phase_start="$(clx_time_ms)"
  clx_sync_skills
  clx_debug_phase "skills-sync" "$phase_start"

  # Config sync.
  phase_start="$(clx_time_ms)"
  clx_sync_config
  clx_debug_phase "config-sync" "$phase_start"

  # Apply model override.
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

  printf "%b%s%b Claude Code Status\n" "${VIOLET}${BOLD}" "" "${RESET}"
  printf "  Engine:          claude\n"
  printf "  Wrapper:         clx %s\n" "${WRAPPER_VERSION:-unknown}"
  printf "  CLI:             %s\n" "${claude_version:-not installed}"
  printf "  FQDN:            %s\n" "${CLAUDE_SYNC_FQDN:-not configured}"
  printf "  Secure:          %s\n" "${CLAUDE_HOST_SECURE:-unknown}"
  printf "  Sync URL:        %s\n" "${CLAUDE_SYNC_BASE_URL:-not configured}"
  printf "  Auth:            %s\n" "$([[ -f "$CLX_AUTH_FILE" ]] && echo "present" || echo "missing")"
  printf "  Config:          %s\n" "$([[ -f "$CLX_SETTINGS_FILE" ]] && echo "present" || echo "missing")"
  printf "  CLAUDE.md:       %s\n" "$([[ -f "$CLX_AGENTS_FILE" ]] && echo "present" || echo "missing")"
  if [[ -n "$CLAUDE_HOST_MODEL" ]] && [[ "$CLAUDE_HOST_MODEL" != "__CLAUDE_HOST_MODEL__" ]]; then
    printf "  Model override:  %s\n" "$CLAUDE_HOST_MODEL"
  fi
}

clx_doctor() {
  print_doctor_report
}
