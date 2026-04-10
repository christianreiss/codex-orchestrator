# ── CLAUDE.md Sync ────────────────────────────────────────────
# Fetches the canonical CLAUDE.md from the orchestrator.

CLX_AGENTS_FILE="${CLX_CONFIG_DIR}/CLAUDE.md"
CLX_AGENTS_DIGEST_FILE="${CLX_CACHE_DIR}/agents_digest"

clx_agents_digest() {
  if [[ -f "$CLX_AGENTS_FILE" ]]; then
    sha256sum "$CLX_AGENTS_FILE" 2>/dev/null | awk '{print $1}' || true
  fi
}

clx_sync_agents() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  local digest=""
  digest="$(clx_agents_digest)"

  local response=""
  response=$(clx_curl -X POST "${CLAUDE_SYNC_BASE_URL}/agents/retrieve" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg digest "$digest" --arg engine "claude" \
      '{digest: $digest, engine: $engine}')" \
    2>/dev/null) || return 0

  local status=""
  status="$(printf '%s' "$response" | jq -r '.data.status // empty' 2>/dev/null || true)"

  if [[ "$status" == "outdated" ]] || [[ "$status" == "updated" ]]; then
    local body=""
    body="$(printf '%s' "$response" | jq -r '.data.body // empty' 2>/dev/null || true)"
    if [[ -n "$body" ]]; then
      printf '%s' "$body" > "$CLX_AGENTS_FILE"
      log_info "CLAUDE.md updated from orchestrator."
    fi
  fi
}
