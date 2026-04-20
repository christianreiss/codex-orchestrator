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

  local response=""
  response="$(clx_curl -X POST "${CLAUDE_SYNC_BASE_URL}/auth" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc \
      --arg cmd "store" \
      --arg engine "claude" \
      --arg client_version "${LOCAL_CLAUDE_VERSION:-unknown}" \
      --arg wrapper_version "${WRAPPER_VERSION:-unknown}" \
      --arg installation_id "${CLAUDE_INSTALLATION_ID:-}" \
      --argjson auth "$auth_body" \
      '{
        command: $cmd,
        engine: $engine,
        client_version: $client_version,
        wrapper_version: $wrapper_version,
        auth: $auth
      } + (if $installation_id == "" then {} else {installation_id: $installation_id} end)')" \
    2>/dev/null)" || {
    log_warn "Failed to push auth to orchestrator."
    return 1
  }

  local returned_auth=""
  returned_auth="$(printf '%s' "$response" | jq '.data.auth // empty' 2>/dev/null || true)"
  if [[ -n "$returned_auth" && "$returned_auth" != "null" ]]; then
    printf '%s' "$returned_auth" > "$CLX_AUTH_FILE"
    chmod 600 "$CLX_AUTH_FILE"
  fi
  clx_remember_auth_digest "$(printf '%s' "$response" | jq -r '.data.canonical_digest // empty' 2>/dev/null || true)"

  log_debug "Pushed local auth to orchestrator."
  return 0
}

clx_prepare_auth_upload_file() {
  local source_path="$CLX_AUTH_FILE"
  if [[ ! -f "$source_path" && -f "$HOME/.claude/.credentials.json" ]]; then
    mkdir -p "$CLX_AUTH_DIR"
    cp "$HOME/.claude/.credentials.json" "$CLX_AUTH_FILE"
    chmod 600 "$CLX_AUTH_FILE"
    source_path="$CLX_AUTH_FILE"
  fi

  if [[ ! -f "$source_path" ]]; then
    log_error "No local Claude credentials found. Run 'claude login' first, then retry 'clx auth-upload'."
    return 1
  fi

  local lr
  lr="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local tmp_auth
  tmp_auth="$(mktemp)" || return 1
  if jq --arg lr "$lr" 'if (.last_refresh | type) != "string" or (.last_refresh | length) == 0 then . + {last_refresh: $lr} else . end' "$source_path" > "$tmp_auth" 2>/dev/null; then
    mv "$tmp_auth" "$CLX_AUTH_FILE"
    chmod 600 "$CLX_AUTH_FILE"
  else
    rm -f "$tmp_auth"
  fi

  if ! validate_auth_json_file "$CLX_AUTH_FILE"; then
    log_error "Local Claude credentials are not uploadable. Run 'claude login' first, then retry 'clx auth-upload'."
    return 1
  fi
}

clx_auth_upload_command() {
  if [[ -z "${CLAUDE_SYNC_BASE_URL:-}" ]] || [[ -z "${CLAUDE_SYNC_API_KEY:-}" ]]; then
    log_error "Sync config missing API key or base URL; download a fresh clx wrapper from the server."
    return 1
  fi

  clx_prepare_auth_upload_file || return 1
  if clx_auth_push; then
    log_info "Uploaded current Claude credentials."
    return 0
  fi

  return 1
}
