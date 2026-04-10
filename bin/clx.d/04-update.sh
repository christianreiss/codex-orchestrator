# ── CLX Self-Update ───────────────────────────────────────────

CLX_UPDATE_CHECK_FILE="${CLX_CACHE_DIR}/update_last_check"
CLX_UPDATE_CHECK_INTERVAL=3600 # 1 hour
CLX_AUTO_UPDATE_ENABLED="${CLX_AUTO_UPDATE_ENABLED:-1}"

clx_update_should_check() {
  if [[ ! -f "$CLX_UPDATE_CHECK_FILE" ]]; then
    return 0
  fi
  local last_check
  last_check="$(cat "$CLX_UPDATE_CHECK_FILE" 2>/dev/null || echo 0)"
  local now
  now="$(date +%s)"
  if (( (now - last_check) > CLX_UPDATE_CHECK_INTERVAL )); then
    return 0
  fi
  return 1
}

clx_check_wrapper_update() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    return 0
  fi

  if ! clx_update_should_check; then
    return 0
  fi

  local response=""
  response=$(clx_curl "${CLAUDE_SYNC_BASE_URL}/wrapper?engine=claude" 2>/dev/null) || return 0

  local remote_version=""
  remote_version="$(printf '%s' "$response" | jq -r '.data.version // empty' 2>/dev/null || true)"

  local auto_update=""
  auto_update="$(printf '%s' "$response" | jq -r '.data.auto_update_enabled // false' 2>/dev/null || echo "false")"

  if [[ -n "$remote_version" ]] && [[ "$remote_version" != "$WRAPPER_VERSION" ]]; then
    if [[ "$auto_update" == "true" ]] && [[ "$CLX_AUTO_UPDATE_ENABLED" == "1" ]]; then
      log_info "Auto-updating CLX wrapper: ${WRAPPER_VERSION} -> ${remote_version}"
      clx_do_update "$@" || log_warn "Auto-update failed; continuing with current version."
    else
      log_info "CLX wrapper update available: ${WRAPPER_VERSION} -> ${remote_version}"
      log_info "Run 'clx --update' to update."
    fi
  fi

  date +%s > "$CLX_UPDATE_CHECK_FILE"
}

clx_do_update() {
  if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then
    log_error "No sync URL configured; cannot update."
    return 1
  fi

  log_info "Downloading updated CLX wrapper..."
  local tmp_wrapper
  tmp_wrapper="$(mktemp)"

  if ! clx_curl -o "$tmp_wrapper" "${CLAUDE_SYNC_BASE_URL}/wrapper/download?engine=claude" 2>/dev/null; then
    rm -f "$tmp_wrapper"
    log_error "Failed to download updated wrapper."
    return 1
  fi

  # Verify it's a valid shell script.
  if ! head -1 "$tmp_wrapper" | grep -q '#!/usr/bin/env bash'; then
    rm -f "$tmp_wrapper"
    log_error "Downloaded file is not a valid wrapper script."
    return 1
  fi

  local self_path=""
  self_path="$(realpath "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")"
  chmod +x "$tmp_wrapper"
  mv "$tmp_wrapper" "$self_path"
  log_info "CLX wrapper updated to latest version."
  log_info "Re-running with updated wrapper..."
  exec "$self_path" "$@"
}

# ── Claude Code CLI Update ────────────────────────────────────
clx_update_cli() {
  log_info "Updating Claude Code CLI..."
  if command -v npm >/dev/null 2>&1; then
    npm update -g @anthropic-ai/claude-code 2>/dev/null && {
      log_info "Claude Code CLI updated."
      return 0
    }
  fi
  log_warn "Could not update Claude Code CLI. Try: npm update -g @anthropic-ai/claude-code"
  return 1
}

