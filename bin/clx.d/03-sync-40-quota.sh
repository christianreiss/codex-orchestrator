# ── Claude Quota & Usage Tracking ─────────────────────────────
# Checks quota policy from orchestrator and enforces limits.
# The quota policy (hard fail, limit percent) applies to both CDX and CLX.

CLX_QUOTA_CACHE="${CLX_CACHE_DIR}/quota_status.json"

clx_check_quota() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  local response=""
  response=$(clx_curl "${CLAUDE_SYNC_BASE_URL}/versions" 2>/dev/null) || return 0

  local quota_hard_fail=""
  quota_hard_fail="$(printf '%s' "$response" | jq -r '.data.quota_hard_fail // false' 2>/dev/null || echo "false")"

  local quota_limit_percent=""
  quota_limit_percent="$(printf '%s' "$response" | jq -r '.data.quota_limit_percent // 100' 2>/dev/null || echo "100")"

  # Store quota status for later reference.
  printf '%s' "$response" | jq '{
    quota_hard_fail: .data.quota_hard_fail,
    quota_limit_percent: .data.quota_limit_percent,
    checked_at: now | todate
  }' > "$CLX_QUOTA_CACHE" 2>/dev/null || true

  # Check Claude-specific usage from auth response.
  local claude_usage=""
  claude_usage="$(printf '%s' "$response" | jq '.data.claude_usage // empty' 2>/dev/null || true)"

  if [[ -n "$claude_usage" ]] && [[ "$claude_usage" != "null" ]]; then
    local spend_used=""
    spend_used="$(printf '%s' "$claude_usage" | jq -r '.spend_used // 0' 2>/dev/null || echo "0")"
    local spend_limit=""
    spend_limit="$(printf '%s' "$claude_usage" | jq -r '.spend_limit // 0' 2>/dev/null || echo "0")"

    if [[ "$spend_limit" != "0" ]] && [[ "$spend_limit" != "null" ]]; then
      local spend_pct
      spend_pct=$(awk "BEGIN { printf \"%.0f\", ($spend_used / $spend_limit) * 100 }" 2>/dev/null || echo "0")
      if (( spend_pct >= quota_limit_percent )); then
        log_warn "Claude API spend: \$${spend_used} of \$${spend_limit} (${spend_pct}%)"
        if [[ "$quota_hard_fail" == "true" ]]; then
          log_error "Quota limit reached. Contact your administrator to continue."
          exit 1
        fi
      fi
    fi
  fi
}

