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

  # Fetch expected SHA256 from the metadata endpoint so we can verify the download.
  # This mirrors cdx's update path and guards against MITM / partial downloads.
  local meta_response=""
  meta_response="$(clx_curl "${CLAUDE_SYNC_BASE_URL}/wrapper?engine=claude" 2>/dev/null || true)"
  local expected_sha=""
  if [[ -n "$meta_response" ]]; then
    expected_sha="$(printf '%s' "$meta_response" | jq -r '.data.sha256 // empty' 2>/dev/null || true)"
  fi

  log_info "Downloading updated CLX wrapper..."
  local tmp_wrapper
  tmp_wrapper="$(mktemp)"

  if ! clx_curl -o "$tmp_wrapper" "${CLAUDE_SYNC_BASE_URL}/wrapper/download?engine=claude" 2>/dev/null; then
    rm -f "$tmp_wrapper"
    log_error "Failed to download updated wrapper."
    return 1
  fi

  # Verify SHA256 if the server provided one. Abort on mismatch.
  if [[ -n "$expected_sha" ]]; then
    local actual_sha=""
    actual_sha="$(sha256sum "$tmp_wrapper" 2>/dev/null | awk '{print $1}' || true)"
    if [[ -z "$actual_sha" ]]; then
      rm -f "$tmp_wrapper"
      log_error "Could not compute SHA256 of downloaded wrapper."
      return 1
    fi
    if [[ "$actual_sha" != "$expected_sha" ]]; then
      rm -f "$tmp_wrapper"
      log_error "Wrapper SHA256 mismatch: expected ${expected_sha}, got ${actual_sha}."
      log_error "Refusing to install unverified wrapper."
      return 1
    fi
    log_debug "Wrapper SHA256 verified: ${actual_sha}"
  else
    log_warn "Server did not return a SHA256; falling back to shebang sanity check."
  fi

  # Final sanity: verify it's a valid shell script (shebang).
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

  # Depth guard: refuse to re-exec more than twice in a single invocation.
  # A misconfigured server that keeps sending "new" bytes of the same version
  # would otherwise hot-loop. Two restarts covers the legitimate case (initial
  # exec -> update -> exec; if the next bootstrap still claims an update is
  # needed, something's wrong and we bail out with an error).
  local depth="${CLAUDE_WRAPPER_RESTART_DEPTH:-0}"
  depth=$((depth + 1))
  if (( depth > 2 )); then
    log_error "Wrapper has restarted ${depth} times in one invocation; bailing out to avoid an update loop."
    log_error "Investigate the /wrapper?engine=claude endpoint (stale version or checksum mismatch)."
    return 1
  fi

  log_info "Re-running with updated wrapper..."
  exec env CLAUDE_WRAPPER_RESTART_DEPTH="$depth" "$self_path" "$@"
}

# ── Claude Code CLI Update ────────────────────────────────────
clx_update_cli() {
  log_info "Updating Claude Code CLI..."
  if ! command -v npm >/dev/null 2>&1; then
    log_error "Claude Code CLI update requires npm (Node.js >= 18); please install npm first."
    return 1
  fi

  # First attempt: install -g (works for missing or stale installs).
  if npm install -g @anthropic-ai/claude-code 2>/tmp/clx-npm.log; then
    log_info "Claude Code CLI installed/updated."
    return 0
  fi

  # Fallback: try sudo if available. Non-fatal — operator can update manually.
  if command -v sudo >/dev/null 2>&1; then
    log_debug "Retrying CLI update with sudo..."
    if sudo -n npm install -g @anthropic-ai/claude-code 2>/tmp/clx-npm.log; then
      log_info "Claude Code CLI installed/updated (sudo)."
      return 0
    fi
  fi

  log_warn "Could not update Claude Code CLI via npm. Try manually:"
  log_warn "  npm install -g @anthropic-ai/claude-code"
  return 1
}

