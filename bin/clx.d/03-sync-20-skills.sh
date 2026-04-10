# ── Skills Sync ───────────────────────────────────────────────
# Fetches skills (universal + Claude-specific) from the orchestrator.

CLX_SKILLS_MANIFEST="${CLX_CACHE_DIR}/skills_manifest.json"

clx_sync_skills() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  local response=""
  response=$(clx_curl "${CLAUDE_SYNC_BASE_URL}/skills?engine=claude" 2>/dev/null) || return 0

  local count=""
  count="$(printf '%s' "$response" | jq '.data.skills | length' 2>/dev/null || echo 0)"

  if [[ "$count" -gt 0 ]]; then
    printf '%s' "$response" | jq '.data.skills' > "$CLX_SKILLS_MANIFEST"
    log_debug "Synced ${count} skill(s) from orchestrator."
  fi
}
