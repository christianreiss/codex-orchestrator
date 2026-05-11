# ── CLX Quota Policy Display ─────────────────────────────────
# Fetches quota policy values used by status/doctor output.

# Apply quota policy values from a source (cache or API response).
_clx_apply_quota_policy() {
  local hard_fail="$1" limit_pct="$2"
  if [[ "$hard_fail" == "true" ]]; then
    QUOTA_HARD_FAIL=1
  elif [[ "$hard_fail" == "false" ]]; then
    QUOTA_HARD_FAIL=0
  fi
  [[ "$limit_pct" =~ ^[0-9]+$ ]] && QUOTA_LIMIT_PERCENT="$limit_pct"
}

if [[ -f "${CLX_QUOTA_CACHE:-}" ]]; then
  _clx_apply_quota_policy \
    "$(jq -r '.quota_hard_fail // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)" \
    "$(jq -r '.quota_limit_percent // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)"
fi

if [[ -n "$CLAUDE_SYNC_BASE_URL" ]] && [[ -n "$CLAUDE_SYNC_API_KEY" ]]; then
  _clx_versions_resp="$(clx_curl "${CLAUDE_SYNC_BASE_URL}/versions" 2>/dev/null || true)"
  if [[ -n "$_clx_versions_resp" ]]; then
    _clx_apply_quota_policy \
      "$(printf '%s' "$_clx_versions_resp" | jq -r '.data.quota_hard_fail // empty' 2>/dev/null || true)" \
      "$(printf '%s' "$_clx_versions_resp" | jq -r '.data.quota_limit_percent // empty' 2>/dev/null || true)"
  fi
fi

quota_lane_display="standard"
primary_quota_segment=""
