# ── Claude Config Sync ────────────────────────────────────────
# Fetches settings.json from the orchestrator.
# Claude Code uses ~/.claude/settings.json for configuration.

CLX_SETTINGS_FILE="${CLX_CONFIG_DIR}/settings.json"
CLX_CONFIG_DIGEST_FILE="${CLX_CACHE_DIR}/config_digest"

clx_config_digest() {
  if [[ -f "$CLX_SETTINGS_FILE" ]]; then
    sha256sum "$CLX_SETTINGS_FILE" 2>/dev/null | awk '{print $1}' || true
  fi
}

clx_sync_config() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  local digest=""
  digest="$(clx_config_digest)"

  local response=""
  response=$(clx_curl -X POST "${CLAUDE_SYNC_BASE_URL}/config/retrieve" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg sha256 "$digest" --arg engine "claude" \
      '{sha256: $sha256, engine: $engine}')" \
    2>/dev/null) || return 0

  local status=""
  status="$(printf '%s' "$response" | jq -r '.data.status // empty' 2>/dev/null || true)"

  if [[ "$status" == "updated" ]]; then
    local body=""
    body="$(printf '%s' "$response" | jq -r '.data.content // empty' 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      printf '%s' "$body" > "$CLX_SETTINGS_FILE"
      log_info "Claude settings.json updated from orchestrator."

      # Apply to Claude Code's config directory.
      local claude_dir="${HOME}/.claude"
      if mkdir -p "$claude_dir" 2>/dev/null; then
        cp "$CLX_SETTINGS_FILE" "${claude_dir}/settings.json" 2>/dev/null || true
      fi
    fi
  fi

  clx_config_digest > "$CLX_CONFIG_DIGEST_FILE"
}

clx_apply_model_override() {
  if [[ -n "$CLAUDE_HOST_MODEL" ]] && [[ "$CLAUDE_HOST_MODEL" != "__CLAUDE_HOST_MODEL__" ]]; then
    export CLAUDE_MODEL="$CLAUDE_HOST_MODEL"
    log_debug "Model override: $CLAUDE_HOST_MODEL"
  fi
}
