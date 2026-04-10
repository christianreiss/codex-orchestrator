# ── CLX Main Entry Point ──────────────────────────────────────

clx_usage() {
  cat <<USAGE
${VIOLET}${BOLD}clx${RESET} — Claude Code fleet wrapper

${BOLD}Usage:${RESET}
  clx                       Launch Claude Code interactively
  clx <prompt>              Run Claude Code with a prompt
  clx --execute "<cmd>"     One-shot execution
  clx --continue            Continue last conversation
  clx --resume <session>    Resume a specific session
  clx status                Show CLX status
  clx doctor                Diagnose CLX setup
  clx --update              Update CLX wrapper + Claude CLI
  clx --cron                Run cron auto-update check
  clx --cron install        Install cron auto-update job
  clx --cron remove         Remove cron auto-update job
  clx --uninstall           Decommission this host
  clx --version             Show version
  clx --help                Show this help

${BOLD}Environment:${RESET}
  CLAUDE_MODEL              Override the model (e.g. claude-sonnet-4-6)
  CLAUDE_DEBUG=1            Enable debug output
  CLAUDE_SILENT=1           Suppress CLX output (pass-through only)

USAGE
}

clx_record_usage() {
  # Extract and report token usage from Claude Code session JSONL files.
  # Falls back to a minimal activity ping if extraction finds nothing.
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  send_claude_usage_from_session_jsonl
  if [[ "${USAGE_PUSH_RESULT:-}" == "ok" ]]; then
    return 0
  fi

  # Fallback: send a minimal usage ping so the orchestrator knows the host is active.
  clx_curl -X POST "${CLAUDE_SYNC_BASE_URL}/usage" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg engine "claude" --arg fqdn "$CLAUDE_SYNC_FQDN" \
      '{engine: $engine, fqdn: $fqdn, entries: []}')" \
    >/dev/null 2>&1 || true
}

clx_uninstall() {
  log_info "Decommissioning this host..."
  if [[ -n "$CLAUDE_SYNC_BASE_URL" ]] && [[ -n "$CLAUDE_SYNC_API_KEY" ]]; then
    clx_curl -X DELETE "${CLAUDE_SYNC_BASE_URL}/auth?engine=claude" >/dev/null 2>&1 || true
  fi
  rm -rf "$CLX_DATA_DIR"
  local self_path=""
  self_path="$(realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
  rm -f "$self_path"
  log_info "CLX uninstalled. Goodbye!"
}

clx_run_claude() {
  local claude_cli=""
  claude_cli="$(detect_claude_cli || true)"

  if [[ -z "$claude_cli" ]]; then
    # Fall back to npx.
    if command -v npx >/dev/null 2>&1; then
      claude_cli="npx"
      set -- @anthropic-ai/claude-code "$@"
    else
      log_error "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
      exit 1
    fi
  fi

  # Set up Claude Code environment.
  if [[ -f "$CLX_AUTH_FILE" ]]; then
    # Extract API key from credentials if present.
    local api_key=""
    api_key="$(jq -r '.api_key // .anthropic_api_key // empty' "$CLX_AUTH_FILE" 2>/dev/null || true)"
    if [[ -n "$api_key" ]]; then
      export ANTHROPIC_API_KEY="$api_key"
    fi
  fi

  # Point Claude Code to the CLAUDE.md if synced.
  if [[ -f "$CLX_AGENTS_FILE" ]]; then
    export CLAUDE_MD="$CLX_AGENTS_FILE"
  fi

  # Start IPv4 proxy if requested.
  if start_claude_ipv4_proxy 2>/dev/null; then
    export HTTPS_PROXY="$CLAUDE_IPV4_PROXY_URL"
    export HTTP_PROXY="$CLAUDE_IPV4_PROXY_URL"
    log_debug "IPv4 proxy active at $CLAUDE_IPV4_PROXY_URL"
  fi

  # Record run start time for session JSONL filtering.
  CLX_RUN_START_NS="$(clx_time_ms)"

  # Execute Claude Code.
  local exit_code=0
  "$claude_cli" "$@" || exit_code=$?

  # Stop IPv4 proxy.
  stop_claude_ipv4_proxy 2>/dev/null || true

  # Record usage (best-effort, non-blocking).
  clx_record_usage &

  return "$exit_code"
}

# ── Main dispatch ─────────────────────────────────────────────
clx_main() {
  case "${1:-}" in
    --help | -h)
      clx_usage
      exit 0
      ;;
    --version | -v)
      printf "clx %s (engine: claude)\n" "${WRAPPER_VERSION:-dev}"
      exit 0
      ;;
    --cron)
      CLAUDE_SILENT=1
      shift
      case "${1:-}" in
        install)
          install_cron_job
          exit $?
          ;;
        remove)
          remove_cron_job
          exit $?
          ;;
      esac
      cron_auto_update
      exit $?
      ;;
    --update)
      shift
      clx_do_update "$@"
      clx_update_cli
      exit 0
      ;;
    --uninstall)
      clx_uninstall
      exit 0
      ;;
    status)
      CLAUDE_STATUS_ONLY=1
      CLAUDE_WANTS_RUN=0
      clx_acquire_lock
      clx_bootstrap
      clx_display
      exit 0
      ;;
    doctor)
      CLAUDE_DOCTOR_ONLY=1
      CLAUDE_WANTS_RUN=0
      clx_acquire_lock
      clx_bootstrap
      clx_display
      exit 0
      ;;
    *)
      clx_acquire_lock
      clx_bootstrap

      # Display, entry gating, then launch.
      clx_display
      clx_entry_gate

      clx_run_claude "$@"
      local exit_code=$?

      clx_debug_phase "total" "$CLX_BOOT_START_NS"
      exit "$exit_code"
      ;;
  esac
}

clx_main "$@"
