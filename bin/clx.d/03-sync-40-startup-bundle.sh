# ── Claude Startup Bundle (atomic agents+config+auth sync) ────
# When enabled (CLX_USE_STARTUP_BUNDLE=1), a single POST to /sync/bootstrap
# replaces the three separate sync calls (auth, agents, config). This saves
# two round trips and keeps the three artifacts consistent even if one phase
# fails server-side.
#
# Falls back to the legacy three-call path when:
#   - the env flag is off (default for now while the endpoint is proven),
#   - the server responds with a shape we don't recognize,
#   - the server returns a 4xx/5xx,
#   - python3 / jq are unavailable.
#
# Mirrors cdx's 03-sync-40-config/20-startup-bundle-python.sh (simpler because
# Claude has no ChatGPT quota or lane concept).

CLX_USE_STARTUP_BUNDLE="${CLX_USE_STARTUP_BUNDLE:-0}"
CLX_STARTUP_BUNDLE_STATUS="not_attempted"
CLX_STARTUP_BUNDLE_REASON=""

clx_startup_bundle_enabled() {
  [[ "${CLX_USE_STARTUP_BUNDLE}" == "1" ]]
}

clx_startup_bundle_pull() {
  CLX_STARTUP_BUNDLE_STATUS="error"
  CLX_STARTUP_BUNDLE_REASON=""

  if ! clx_startup_bundle_enabled; then
    CLX_STARTUP_BUNDLE_STATUS="disabled"
    return 1
  fi

  if [[ -z "${CLAUDE_SYNC_BASE_URL:-}" ]] || [[ -z "${CLAUDE_SYNC_API_KEY:-}" ]]; then
    CLX_STARTUP_BUNDLE_STATUS="missing-config"
    return 1
  fi

  if ! command -v jq >/dev/null 2>&1; then
    CLX_STARTUP_BUNDLE_STATUS="no-jq"
    return 1
  fi

  local agents_sha=""
  if [[ -f "$CLX_AGENTS_FILE" ]]; then
    agents_sha="$(sha256sum "$CLX_AGENTS_FILE" 2>/dev/null | awk '{print $1}' || true)"
  fi
  local config_sha=""
  if [[ -f "$CLX_SETTINGS_FILE" ]]; then
    config_sha="$(sha256sum "$CLX_SETTINGS_FILE" 2>/dev/null | awk '{print $1}' || true)"
  fi
  local auth_digest=""
  auth_digest="$(clx_auth_digest)"

  local include_auth="true"
  local request_body
  request_body="$(jq -nc \
    --arg engine "claude" \
    --arg agents_sha "$agents_sha" \
    --arg config_sha "$config_sha" \
    --arg auth_digest "$auth_digest" \
    --argjson include_auth true \
    '{
      engine: $engine,
      include_auth: $include_auth,
      agents: {sha256: $agents_sha},
      config: {sha256: $config_sha},
      auth_digest: $auth_digest
    }')" || {
    CLX_STARTUP_BUNDLE_STATUS="encode-failed"
    return 1
  }

  local tmp_response
  tmp_response="$(mktemp)"
  trap 'rm -f "$tmp_response"' RETURN

  local http_code=""
  http_code="$(clx_curl -o "$tmp_response" -w '%{http_code}' \
    -X POST "${CLAUDE_SYNC_BASE_URL}/sync/bootstrap" \
    -H "Content-Type: application/json" \
    -d "$request_body" 2>/dev/null || echo "000")"

  if [[ "$http_code" == "404" ]]; then
    CLX_STARTUP_BUNDLE_STATUS="endpoint-missing"
    return 1
  fi
  if [[ "$http_code" != "200" ]]; then
    CLX_STARTUP_BUNDLE_STATUS="http-${http_code}"
    return 1
  fi

  local response
  response="$(cat "$tmp_response" 2>/dev/null || true)"
  if [[ -z "$response" ]]; then
    CLX_STARTUP_BUNDLE_STATUS="empty-response"
    return 1
  fi

  # Extract per-section content.
  local agents_status config_status agents_content config_content
  agents_status="$(printf '%s' "$response" | jq -r '.data.agents.status // "missing"' 2>/dev/null || echo "missing")"
  config_status="$(printf '%s' "$response" | jq -r '.data.config.status // "missing"' 2>/dev/null || echo "missing")"

  if [[ "$agents_status" == "updated" ]]; then
    agents_content="$(printf '%s' "$response" | jq -r '.data.agents.content // empty' 2>/dev/null || true)"
    if [[ -n "$agents_content" ]]; then
      printf '%s' "$agents_content" > "$CLX_AGENTS_FILE"
      log_debug "Startup bundle: CLAUDE.md updated."
    fi
  fi

  if [[ "$config_status" == "updated" ]]; then
    config_content="$(printf '%s' "$response" | jq -r '.data.config.content // empty' 2>/dev/null || true)"
    if [[ -n "$config_content" ]]; then
      printf '%s' "$config_content" > "$CLX_SETTINGS_FILE"
      local claude_dir="${HOME}/.claude"
      if [[ -d "$claude_dir" ]]; then
        cp "$CLX_SETTINGS_FILE" "${claude_dir}/settings.json" 2>/dev/null || true
      fi
      log_debug "Startup bundle: settings.json updated."
    fi
  fi

  # If the server returned an auth block (include_auth=true), consume it.
  local auth_block auth_status
  auth_block="$(printf '%s' "$response" | jq '.data.auth // empty' 2>/dev/null || true)"
  if [[ -n "$auth_block" ]] && [[ "$auth_block" != "null" ]]; then
    auth_status="$(printf '%s' "$auth_block" | jq -r '.status // empty' 2>/dev/null || true)"
    case "$auth_status" in
      updated|outdated|valid)
        AUTH_PULL_STATUS="ok"
        ;;
      disabled|invalid|insecure|insecure-denied|concurrent|skip)
        AUTH_PULL_STATUS="$auth_status"
        ;;
      *)
        AUTH_PULL_STATUS="${auth_status:-ok}"
        ;;
    esac
  fi

  CLX_STARTUP_BUNDLE_STATUS="ok"
  date +%s > "$CLX_AUTH_LAST_SYNC"
  return 0
}
