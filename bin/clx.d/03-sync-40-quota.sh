# ── Claude Quota Policy Sync ─────────────────────────────────
# Checks quota policy from orchestrator and caches it for display/status.

CLX_QUOTA_CACHE="${CLX_CACHE_DIR}/quota_status.json"

clx_check_quota() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  local response=""
  response=$(clx_curl "${CLAUDE_SYNC_BASE_URL}/versions" 2>/dev/null) || return 0

  # Store quota status for later reference.
  printf '%s' "$response" | jq '{
    quota_hard_fail: .data.quota_hard_fail,
    quota_limit_percent: .data.quota_limit_percent,
    checked_at: now | todate
  }' > "$CLX_QUOTA_CACHE" 2>/dev/null || true
}
