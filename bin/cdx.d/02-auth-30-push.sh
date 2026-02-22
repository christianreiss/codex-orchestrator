push_auth_if_changed() {
  local phase="${1:-push}"
  local auth_path="$HOME/.codex/auth.json"
  local refreshed
  refreshed="$(get_auth_last_refresh "$auth_path")"
  # No local auth present
  if [[ -z "$ORIGINAL_LAST_REFRESH" && -z "$refreshed" ]]; then
    AUTH_PUSH_RESULT="skipped"
    AUTH_PUSH_REASON="no local auth.json"
    return 0
  fi
  if [[ "$refreshed" == "$ORIGINAL_LAST_REFRESH" ]]; then
    AUTH_PUSH_RESULT="not-needed"
    AUTH_PUSH_REASON="auth.json unchanged"
    return 0
  fi
  if sync_auth_with_api "$phase"; then
    SYNC_PUSH_COMPLETED=1
    AUTH_PUSH_RESULT="uploaded"
    AUTH_PUSH_REASON="auth.json changed"
    return 0
  fi
  AUTH_PUSH_RESULT="failed"
  AUTH_PUSH_REASON="api sync error"
  return 1
}
