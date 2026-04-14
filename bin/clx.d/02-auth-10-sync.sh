# ── Claude Auth Sync ──────────────────────────────────────────
# Syncs Claude/Anthropic credentials from the orchestrator.
# Claude Code uses ~/.claude/.credentials.json or ANTHROPIC_API_KEY env var.

CLX_AUTH_FILE="${CLX_AUTH_DIR}/credentials.json"
CLX_AUTH_DIGEST_FILE="${CLX_CACHE_DIR}/auth_digest"
CLX_AUTH_LAST_SYNC="${CLX_CACHE_DIR}/auth_last_sync"
CLX_AUTH_CACHE_TTL=86400 # 24 hours
CLX_AUTH_FALLBACK_TTL=604800 # 7 days for secure hosts

clx_auth_digest() {
  if [[ -f "$CLX_AUTH_FILE" ]]; then
    sha256sum "$CLX_AUTH_FILE" 2>/dev/null | awk '{print $1}' || true
  fi
}

clx_auth_should_sync() {
  if [[ ! -f "$CLX_AUTH_LAST_SYNC" ]]; then
    return 0
  fi
  local last_sync
  last_sync="$(cat "$CLX_AUTH_LAST_SYNC" 2>/dev/null || echo 0)"
  local now
  now="$(date +%s)"
  local ttl="$CLX_AUTH_CACHE_TTL"
  if [[ "$CLAUDE_HOST_SECURE" == "1" ]]; then
    ttl="$CLX_AUTH_CACHE_TTL"
  else
    ttl="$CLX_AUTH_FALLBACK_TTL"
  fi
  if (( (now - last_sync) > ttl )); then
    return 0
  fi
  return 1
}

clx_auth_sync() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    log_debug "No sync URL or API key configured; skipping auth sync."
    AUTH_PULL_STATUS="skip"
    return 0
  fi

  if ! clx_auth_should_sync; then
    log_debug "Auth sync not due yet; using cached credentials."
    AUTH_PULL_STATUS="ok"
    return 0
  fi

  local digest=""
  digest="$(clx_auth_digest)"

  log_debug "Syncing Claude auth from orchestrator..."

  local response=""
  local http_code=""
  local tmp_response
  tmp_response="$(mktemp)"
  trap 'rm -f "$tmp_response"' RETURN

  http_code=$(clx_curl -o "$tmp_response" -w '%{http_code}' \
    -X POST "${CLAUDE_SYNC_BASE_URL}/auth" \
    -H "Content-Type: application/json" \
    -d "$(jq -nc --arg cmd "retrieve" --arg digest "$digest" --arg engine "claude" \
      '{command: $cmd, digest: $digest, engine: $engine}')" \
    2>/dev/null) || true

  if [[ "$http_code" != "200" ]]; then
    log_warn "Auth sync returned HTTP ${http_code}; using cached credentials."
    AUTH_PULL_STATUS="offline"
    AUTH_PULL_REASON="HTTP ${http_code}"
    return 0
  fi

  response="$(cat "$tmp_response" 2>/dev/null || true)"

  local status=""
  status="$(printf '%s' "$response" | jq -r '.data.status // empty' 2>/dev/null || true)"

  case "$status" in
    valid)
      log_debug "Auth is up to date."
      AUTH_PULL_STATUS="ok"
      ;;
    outdated|updated)
      local auth_body=""
      auth_body="$(printf '%s' "$response" | jq '.data.auth' 2>/dev/null || true)"
      if [[ -n "$auth_body" ]] && [[ "$auth_body" != "null" ]]; then
        printf '%s' "$auth_body" > "$CLX_AUTH_FILE"
        chmod 600 "$CLX_AUTH_FILE"
        log_info "Claude auth updated from orchestrator."
      fi
      AUTH_PULL_STATUS="ok"
      ;;
    upload_required|missing)
      if [[ -f "$CLX_AUTH_FILE" ]]; then
        log_info "Orchestrator requests auth upload; pushing local credentials..."
        clx_auth_push
      else
        log_warn "Orchestrator has no auth and no local credentials found."
      fi
      AUTH_PULL_STATUS="ok"
      ;;
    disabled)
      AUTH_PULL_STATUS="disabled"
      ;;
    invalid)
      AUTH_PULL_STATUS="invalid"
      ;;
    insecure)
      AUTH_PULL_STATUS="insecure"
      ;;
    insecure-denied)
      AUTH_PULL_STATUS="insecure-denied"
      ;;
    concurrent)
      AUTH_PULL_STATUS="concurrent"
      ;;
    *)
      log_debug "Auth sync status: ${status:-unknown}"
      AUTH_PULL_STATUS="${status:-fail}"
      ;;
  esac

  # Update local auth state flags.
  if [[ -f "$CLX_AUTH_FILE" ]]; then
    HAS_LOCAL_AUTH=1
    local api_key_check=""
    api_key_check="$(jq -r '.api_key // .anthropic_api_key // empty' "$CLX_AUTH_FILE" 2>/dev/null || true)"
    if [[ -n "$api_key_check" ]]; then
      HAS_VALID_LOCAL_AUTH=1
    fi
  fi

  if [[ -f "$CLX_AUTH_LAST_SYNC" ]]; then
    local last_sync_ts=""
    last_sync_ts="$(cat "$CLX_AUTH_LAST_SYNC" 2>/dev/null || echo 0)"
    local now_ts=""
    now_ts="$(date +%s)"
    ORIGINAL_LAST_REFRESH="$last_sync_ts"
    if (( (now_ts - last_sync_ts) < CLX_AUTH_CACHE_TTL )); then
      LOCAL_AUTH_IS_FRESH=1
    fi
  fi

  date +%s > "$CLX_AUTH_LAST_SYNC"
  clx_auth_digest > "$CLX_AUTH_DIGEST_FILE"
}

# clx_auth_push() is defined in 02-auth-30-push.sh (extracted for parity with cdx).
