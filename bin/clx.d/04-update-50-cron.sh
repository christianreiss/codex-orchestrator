# Cron auto-update mode: lightweight path that skips auth sync and interactive launch.
# Invoked via: clx --cron [install|remove]

CRON_CHECK_RESPONSE=""

cron_resolve_self() {
  realpath "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0"
}

cron_managed_marker() {
  printf '%s' '# clx-managed-cron'
}

cron_entry_matches_wrapper() {
  local line="$1"
  local clx_path="$2"
  local quoted_clx_path="$3"
  local marker="$4"

  [[ "$line" == *"$marker"* ]] && return 0
  [[ "$line" == *"$clx_path"* && "$line" == *" --cron"* ]] && return 0
  [[ "$line" == *"$quoted_clx_path"* && "$line" == *" --cron"* ]] && return 0
  return 1
}

cron_has_wrapper_entry() {
  local crontab_text="$1"
  local clx_path="$2"
  local quoted_clx_path="$3"
  local marker="$4"
  local line=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if cron_entry_matches_wrapper "$line" "$clx_path" "$quoted_clx_path" "$marker"; then
      return 0
    fi
  done <<<"$crontab_text"

  return 1
}

cron_filter_existing_entries() {
  local clx_path="$1"
  local quoted_clx_path="$2"
  local marker="$3"
  local line=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if cron_entry_matches_wrapper "$line" "$clx_path" "$quoted_clx_path" "$marker"; then
      continue
    fi
    printf '%s\n' "$line"
  done
}

cron_wrapper_entry_installed() {
  if ! command -v crontab >/dev/null 2>&1; then
    return 1
  fi

  local clx_path quoted_clx_path marker current_crontab
  clx_path="$(cron_resolve_self)"
  if [[ ! -x "$clx_path" ]]; then
    return 1
  fi

  printf -v quoted_clx_path '%q' "$clx_path"
  marker="$(cron_managed_marker)"
  current_crontab="$(crontab -l 2>/dev/null || true)"
  cron_has_wrapper_entry "$current_crontab" "$clx_path" "$quoted_clx_path" "$marker"
}

install_cron_job() {
  if ! command -v crontab >/dev/null 2>&1; then
    log_error "Cannot install clx cron job because crontab is unavailable."
    return 1
  fi

  local clx_path
  clx_path="$(cron_resolve_self)"
  if [[ ! -x "$clx_path" ]]; then
    log_error "Cannot determine clx path for cron entry."
    return 1
  fi

  local log_file="$HOME/.claude/cron.log"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

  # Random minute (0-59) and hour (0-3) unique per host, so not all hosts hit the API at once.
  local rand_minute rand_hour
  rand_minute=$(($(cksum <<<"$(hostname)-min" | cut -d' ' -f1) % 60))
  rand_hour=$(($(cksum <<<"$(hostname)-hr" | cut -d' ' -f1) % 4))

  local quoted_clx_path quoted_log_file cron_command cron_line marker current_crontab filtered_crontab
  printf -v quoted_clx_path '%q' "$clx_path"
  printf -v quoted_log_file '%q' "$log_file"
  cron_command="${quoted_clx_path} --cron >> ${quoted_log_file} 2>&1"
  cron_command="${cron_command//%/\\%}"
  marker="$(cron_managed_marker)"
  cron_line="${rand_minute} ${rand_hour} * * * ${cron_command} ${marker}"
  current_crontab="$(crontab -l 2>/dev/null || true)"

  if printf '%s\n' "$current_crontab" | grep -qF "$cron_line"; then
    printf '%s\n' "clx cron job already installed."
    return 0
  fi

  filtered_crontab="$(printf '%s\n' "$current_crontab" | cron_filter_existing_entries "$clx_path" "$quoted_clx_path" "$marker")"

  {
    if [[ -n "$filtered_crontab" ]]; then
      printf '%s\n' "$filtered_crontab"
    fi
    printf '%s\n' "$cron_line"
  } | crontab -

  printf 'clx cron job installed (daily at %02d:%02d). Log: %s\n' "$rand_hour" "$rand_minute" "$log_file"

  if cron_ping_check_api "cron install"; then
    printf '%s\n' "clx cron install pinged /cron/check successfully."
  else
    log_warn "clx cron job was installed, but the initial /cron/check ping failed."
  fi
}

remove_cron_job() {
  if ! command -v crontab >/dev/null 2>&1; then
    printf '%s\n' "clx cron job not found in crontab."
    return 0
  fi

  local clx_path quoted_clx_path marker current_crontab filtered_crontab
  clx_path="$(cron_resolve_self)"
  printf -v quoted_clx_path '%q' "$clx_path"
  marker="$(cron_managed_marker)"
  current_crontab="$(crontab -l 2>/dev/null || true)"

  if ! cron_has_wrapper_entry "$current_crontab" "$clx_path" "$quoted_clx_path" "$marker"; then
    printf '%s\n' "clx cron job not found in crontab."
    return 0
  fi

  filtered_crontab="$(printf '%s\n' "$current_crontab" | cron_filter_existing_entries "$clx_path" "$quoted_clx_path" "$marker")"
  printf '%s\n' "$filtered_crontab" | crontab -
  printf '%s\n' "clx cron job removed."
}

reconcile_cron_job_state() {
  local desired_state="$1"

  case "$desired_state" in
    install)
      if cron_wrapper_entry_installed; then
        return 0
      fi
      install_cron_job
      return $?
      ;;
    remove)
      if ! cron_wrapper_entry_installed; then
        return 0
      fi
      remove_cron_job
      return $?
      ;;
    *)
      log_error "Unknown cron reconciliation state: $desired_state"
      return 1
      ;;
  esac
}

cron_do_api_call() {
  local url="$1"
  local json_payload="$2"
  local action_label="$3"

  local response=""
  response=$(clx_curl -X POST "$url" \
    -H "Content-Type: application/json" \
    -d "$json_payload" 2>&1) || {
    printf '%s failed: %s\n' "$action_label" "$response" >&2
    return 2
  }
  printf '%s' "$response"
}

cron_build_check_payload() {
  if [[ -z "$CLAUDE_SYNC_API_KEY" || -z "$CLAUDE_SYNC_BASE_URL" ]]; then
    log_error "sync config missing; cannot ping /cron/check."
    return 1
  fi

  local claude_cli
  claude_cli="$(detect_claude_cli 2>/dev/null || true)"
  if [[ -z "$claude_cli" ]]; then
    log_error "Claude CLI not found on PATH; cannot ping /cron/check."
    return 1
  fi

  local local_version
  local_version="$("$claude_cli" --version 2>/dev/null || true)"

  jq -nc \
    --arg client_version "${local_version:-unknown}" \
    --arg wrapper_version "${WRAPPER_VERSION:-unknown}" \
    --arg engine "claude" \
    '{client_version: $client_version, wrapper_version: $wrapper_version, engine: $engine}'
}

cron_ping_check_api() {
  local context_label="${1:-cron}"
  CRON_CHECK_RESPONSE=""
  local check_payload
  check_payload="$(cron_build_check_payload)" || {
    log_warn "${context_label}: could not build /cron/check payload."
    return 1
  }

  local check_url="${CLAUDE_SYNC_BASE_URL}/cron/check"
  local check_response
  check_response="$(cron_do_api_call "$check_url" "$check_payload" "cron-check" 2>&1)" || {
    log_warn "${context_label}: /cron/check failed: ${check_response}"
    return 1
  }

  CRON_CHECK_RESPONSE="$check_response"
}

cron_perform_wrapper_self_update() {
  local target_version="$1"
  local target_sha="${2:-}"
  local target_url="${3:-}"

  if [[ -z "$target_url" ]]; then
    return 1
  fi

  local clx_real
  clx_real="$(cron_resolve_self)"

  local tmp_wrapper
  tmp_wrapper="$(mktemp)"

  if ! clx_curl -o "$tmp_wrapper" "$target_url" 2>/dev/null; then
    rm -f "$tmp_wrapper"
    return 1
  fi

  # Verify it starts with a shebang.
  if ! head -1 "$tmp_wrapper" | grep -q '#!/usr/bin/env bash'; then
    rm -f "$tmp_wrapper"
    return 1
  fi

  # Verify SHA-256 if provided.
  if [[ -n "$target_sha" ]]; then
    local dl_sha
    dl_sha="$(sha256sum "$tmp_wrapper" 2>/dev/null | awk '{print $1}' || true)"
    if [[ "$dl_sha" != "$target_sha" ]]; then
      rm -f "$tmp_wrapper"
      return 1
    fi
  fi

  chmod +x "$tmp_wrapper"
  if [[ -w "$(dirname "$clx_real")" ]]; then
    mv "$tmp_wrapper" "$clx_real"
  else
    rm -f "$tmp_wrapper"
    return 1
  fi

  if [[ -n "$target_version" ]]; then
    WRAPPER_VERSION="$target_version"
  fi
  return 0
}

cron_auto_update() {
  local lock_file="$HOME/.claude/.clx_cron.lock"
  local lock_dir_fallback="${lock_file}.d"
  mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true

  # Non-blocking lock to prevent concurrent cron runs.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_file" || {
      printf '[%s] cron: cannot open lock file %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$lock_file"
      return 1
    }
    if ! flock -n 9 2>/dev/null; then
      printf '[%s] cron: another cron run is active; skipping.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      return 0
    fi
  elif mkdir "$lock_dir_fallback" 2>/dev/null; then
    trap 'rmdir "$lock_dir_fallback" 2>/dev/null || true' RETURN
  else
    printf '[%s] cron: another cron run is active; skipping.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
  fi

  local claude_cli local_version
  claude_cli="$(detect_claude_cli 2>/dev/null || true)"
  if [[ -z "$claude_cli" ]]; then
    printf '[%s] cron: Claude CLI not found on PATH.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  local_version="$("$claude_cli" --version 2>/dev/null || true)"

  local check_response
  cron_ping_check_api "cron" || {
    printf '[%s] cron: API check failed: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$CRON_CHECK_RESPONSE"
    return 1
  }
  check_response="$CRON_CHECK_RESPONSE"

  local action wrapper_action wrapper_target_version wrapper_target_sha wrapper_target_url
  local _parsed
  _parsed="$(printf '%s' "$check_response" | jq -r '[
    .data.action // empty,
    .data.wrapper.action // empty,
    .data.wrapper.target_version // empty,
    .data.wrapper.sha256 // empty,
    .data.wrapper.url // empty
  ] | join("\n")' 2>/dev/null || true)"
  IFS=$'\n' read -r action wrapper_action wrapper_target_version wrapper_target_sha wrapper_target_url <<<"$_parsed"
  if [[ -z "$wrapper_target_url" ]] && [[ -n "${CLAUDE_SYNC_BASE_URL:-}" ]]; then
    wrapper_target_url="${CLAUDE_SYNC_BASE_URL%/}/wrapper/download?engine=claude"
  fi
  if [[ -n "$wrapper_target_url" && "$wrapper_target_url" != http* ]]; then
    wrapper_target_url="${CLAUDE_SYNC_BASE_URL%/}${wrapper_target_url}"
  fi

  if [[ "$action" == "disable" ]]; then
    printf '[%s] cron: auto-update disabled by server; removing cron job.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    remove_cron_job
    return 0
  fi

  if [[ "$wrapper_action" == "update" ]]; then
    if [[ -z "$wrapper_target_version" || -z "$wrapper_target_url" ]]; then
      printf '[%s] cron: wrapper update requested but target metadata is incomplete.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      return 1
    fi

    if [[ "${CLX_WRAPPER_RESTARTED:-0}" == "1" ]]; then
      printf '[%s] cron: wrapper update loop detected for target %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$wrapper_target_version"
      return 1
    fi

    local clx_real
    clx_real="$(cron_resolve_self)"
    if cron_perform_wrapper_self_update "$wrapper_target_version" "$wrapper_target_sha" "$wrapper_target_url"; then
      printf '[%s] cron: wrapper updated to %s; restarting cron flow.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$wrapper_target_version"
      exec env CLX_WRAPPER_RESTARTED=1 "$clx_real" --cron
    fi

    printf '[%s] cron: wrapper update to %s failed.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$wrapper_target_version"
    return 1
  fi

  if [[ "$action" == "no_update" ]]; then
    printf '[%s] cron: no update needed.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
  fi

  if [[ "$action" != "update" ]]; then
    printf '[%s] cron: unexpected action "%s" from API.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action"
    return 1
  fi

  # Extract update details.
  local target_version
  target_version="$(printf '%s' "$check_response" | jq -r '.data.target_version // empty' 2>/dev/null || true)"

  if [[ -z "$target_version" ]]; then
    printf '[%s] cron: update action but no target_version provided.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  printf '[%s] cron: update available: %s -> %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${local_version:-unknown}" "$target_version"

  # Claude CLI is npm-based; update via npm.
  if ! command -v npm >/dev/null 2>&1; then
    printf '[%s] cron: npm not found; cannot update Claude CLI.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  if npm update -g @anthropic-ai/claude-code >/dev/null 2>&1; then
    printf '[%s] cron: Claude CLI updated to %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target_version"

    # Verify new version.
    local new_version
    new_version="$("$claude_cli" --version 2>/dev/null || true)"

    # Report success to API.
    local report_payload
    report_payload="$(jq -nc \
      --arg client_version "${new_version:-$target_version}" \
      --arg wrapper_version "${WRAPPER_VERSION:-unknown}" \
      '{client_version: $client_version, wrapper_version: $wrapper_version}')"
    local report_url="${CLAUDE_SYNC_BASE_URL}/cron/report"
    local report_attempt report_ok=0
    for report_attempt in 1 2 3; do
      if cron_do_api_call "$report_url" "$report_payload" "cron-report" >/dev/null 2>&1; then
        report_ok=1
        break
      fi
      sleep 2
    done

    if ((report_ok == 0)); then
      printf '[%s] cron: update report failed after retries (client: %s, wrapper: %s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${new_version:-$target_version}" "${WRAPPER_VERSION:-unknown}"
      return 1
    fi

    printf '[%s] cron: update reported (client: %s, wrapper: %s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${new_version:-$target_version}" "${WRAPPER_VERSION:-unknown}"
    return 0
  else
    printf '[%s] cron: npm update failed for @anthropic-ai/claude-code.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi
}
