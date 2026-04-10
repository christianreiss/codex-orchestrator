# ── CLX Quota Display & Enforcement ───────────────────────────
# Fetches Claude spend data, computes quota state, and builds the
# display segment for the boot screen.
#
# Claude uses a single spend pool (no lanes, no primary/secondary
# windows, no daily budget partitioning).

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

# ── Fetch spend data ─────────────────────────────────────────
_clx_spend_used=""
_clx_spend_limit=""
_clx_spend_reset_after=""

if [[ -f "${CLX_QUOTA_CACHE:-}" ]]; then
  _clx_spend_used="$(jq -r '.spend_used // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)"
  _clx_spend_limit="$(jq -r '.spend_limit // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)"
  _clx_spend_reset_after="$(jq -r '.spend_reset_after // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)"
  _clx_apply_quota_policy \
    "$(jq -r '.quota_hard_fail // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)" \
    "$(jq -r '.quota_limit_percent // empty' "$CLX_QUOTA_CACHE" 2>/dev/null || true)"
fi

if [[ -z "$_clx_spend_used" ]] && [[ -n "$CLAUDE_SYNC_BASE_URL" ]] && [[ -n "$CLAUDE_SYNC_API_KEY" ]]; then
  _clx_versions_resp="$(clx_curl "${CLAUDE_SYNC_BASE_URL}/versions" 2>/dev/null || true)"
  if [[ -n "$_clx_versions_resp" ]]; then
    _clx_claude_usage="$(printf '%s' "$_clx_versions_resp" | jq '.data.claude_usage // empty' 2>/dev/null || true)"
    if [[ -n "$_clx_claude_usage" ]] && [[ "$_clx_claude_usage" != "null" ]]; then
      _clx_spend_used="$(printf '%s' "$_clx_claude_usage" | jq -r '.spend_used // empty' 2>/dev/null || true)"
      _clx_spend_limit="$(printf '%s' "$_clx_claude_usage" | jq -r '.spend_limit // empty' 2>/dev/null || true)"
      _clx_spend_reset_after="$(printf '%s' "$_clx_claude_usage" | jq -r '.spend_reset_after // empty' 2>/dev/null || true)"
    fi
    _clx_apply_quota_policy \
      "$(printf '%s' "$_clx_versions_resp" | jq -r '.data.quota_hard_fail // empty' 2>/dev/null || true)" \
      "$(printf '%s' "$_clx_versions_resp" | jq -r '.data.quota_limit_percent // empty' 2>/dev/null || true)"
  fi
fi

CLAUDE_SPEND_USED="$_clx_spend_used"
CLAUDE_SPEND_LIMIT="$_clx_spend_limit"
CLAUDE_SPEND_RESET_AFTER="$_clx_spend_reset_after"
CLAUDE_SPEND_PCT=""

if [[ -n "$CLAUDE_SPEND_USED" ]] && [[ -n "$CLAUDE_SPEND_LIMIT" ]] \
   && [[ "$CLAUDE_SPEND_LIMIT" != "0" ]] && [[ "$CLAUDE_SPEND_LIMIT" != "null" ]]; then
  CLAUDE_SPEND_PCT=$(awk "BEGIN {
    v = ($CLAUDE_SPEND_USED / $CLAUDE_SPEND_LIMIT) * 100
    printf \"%.0f\", (v < 0 ? 0 : v)
  }" 2>/dev/null || echo "")
fi

# ── Build quota display segment ──────────────────────────────
quota_lane_display="standard"
primary_quota_segment=""

if [[ "$CLAUDE_SPEND_PCT" =~ ^[0-9]+$ ]]; then
  _q_pct=$CLAUDE_SPEND_PCT
  ((_q_pct > 100)) && _q_pct=100

  _q_bar="$(build_quota_bar "$_q_pct" "${QUOTA_BAR_WIDTH:-24}")"

  _q_tone="green"
  ((_q_pct >= 95)) && _q_tone="red"
  ((_q_pct >= 80 && _q_pct < 95)) && _q_tone="orange"

  printf -v _q_text "%3d%% [%s]" "$_q_pct" "$_q_bar"

  _q_note_parts=()
  if [[ -n "$CLAUDE_SPEND_USED" ]] && [[ -n "$CLAUDE_SPEND_LIMIT" ]]; then
    _q_note_parts+=("\$${CLAUDE_SPEND_USED} / \$${CLAUDE_SPEND_LIMIT}")
  fi
  if [[ "$CLAUDE_SPEND_RESET_AFTER" =~ ^[0-9]+$ ]]; then
    _q_dur="$(format_duration_short "$CLAUDE_SPEND_RESET_AFTER")"
    [[ -n "$_q_dur" ]] && _q_note_parts+=("resets in ${_q_dur}")
  fi

  primary_quota_segment="$(colorize "$_q_text" "$_q_tone")"
  if ((${#_q_note_parts[@]})); then
    _q_note_disp=""
    printf -v _q_note_disp "%b" "${DIM}$(join_with_semicolon "${_q_note_parts[@]}")${RESET}"
    primary_quota_segment+=" ${_q_note_disp}"
  fi
fi
