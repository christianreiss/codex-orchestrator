# ── Claude Auth Push ──────────────────────────────────────────
# Pushes a locally-held Claude credentials JSON up to the orchestrator.
# Mirrors cdx's 02-auth-30-push.sh. Called by clx_auth_sync() when the
# orchestrator returns `upload_required` or `missing`.
#
# The dedicated fragment makes it easy to reuse the push path from
# one-shot flows (e.g., a future `clx --seed` command) without dragging
# in the full sync state machine.

clx_auth_push() {
  if [[ ! -f "$CLX_AUTH_FILE" ]]; then
    log_debug "No local auth file to push."
    return 0
  fi

  if [[ -z "${CLAUDE_SYNC_BASE_URL:-}" ]] || [[ -z "${CLAUDE_SYNC_API_KEY:-}" ]]; then
    log_debug "No sync URL or API key; skipping auth push."
    return 0
  fi

  local auth_body=""
  auth_body="$(cat "$CLX_AUTH_FILE" 2>/dev/null || true)"
  if [[ -z "$auth_body" ]]; then
    return 0
  fi

  # Validate before uploading so we don't push a garbage file to the orchestrator.
  if ! validate_auth_json_file "$CLX_AUTH_FILE"; then
    log_warn "Local auth file did not pass validation; refusing to push."
    return 1
  fi

  clx_curl -X POST "${CLAUDE_SYNC_BASE_URL}/auth" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg cmd "store" --arg engine "claude" --argjson auth "$auth_body" \
      '{command: $cmd, engine: $engine, auth: $auth}')" \
    >/dev/null 2>&1 || {
    log_warn "Failed to push auth to orchestrator."
    return 1
  }

  log_debug "Pushed local auth to orchestrator."
  return 0
}
