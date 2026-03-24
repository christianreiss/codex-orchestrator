
# Cron auto-update mode: lightweight path that skips auth sync and interactive launch.
# Invoked via: cdx --cron [install|remove]

cron_managed_marker() {
  printf '%s' '# cdx-managed-cron'
}

cron_entry_matches_wrapper() {
  local line="$1"
  local cdx_path="$2"
  local quoted_cdx_path="$3"
  local marker="$4"

  [[ "$line" == *"$marker"* ]] && return 0
  [[ "$line" == *"$cdx_path"* && "$line" == *" --cron"* ]] && return 0
  [[ "$line" == *"$quoted_cdx_path"* && "$line" == *" --cron"* ]] && return 0
  return 1
}

cron_has_wrapper_entry() {
  local crontab_text="$1"
  local cdx_path="$2"
  local quoted_cdx_path="$3"
  local marker="$4"
  local line=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if cron_entry_matches_wrapper "$line" "$cdx_path" "$quoted_cdx_path" "$marker"; then
      return 0
    fi
  done <<< "$crontab_text"

  return 1
}

cron_filter_existing_entries() {
  local cdx_path="$1"
  local quoted_cdx_path="$2"
  local marker="$3"
  local line=""

  while IFS= read -r line || [[ -n "$line" ]]; do
    if cron_entry_matches_wrapper "$line" "$cdx_path" "$quoted_cdx_path" "$marker"; then
      continue
    fi
    printf '%s\n' "$line"
  done
}

cron_wrapper_entry_installed() {
  if ! command -v crontab >/dev/null 2>&1; then
    return 1
  fi

  local cdx_path quoted_cdx_path marker current_crontab
  cdx_path="$(real_path "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")"
  if [[ ! -x "$cdx_path" ]]; then
    return 1
  fi

  printf -v quoted_cdx_path '%q' "$cdx_path"
  marker="$(cron_managed_marker)"
  current_crontab="$(crontab -l 2>/dev/null || true)"
  cron_has_wrapper_entry "$current_crontab" "$cdx_path" "$quoted_cdx_path" "$marker"
}

install_cron_job() {
  if ! command -v crontab >/dev/null 2>&1; then
    log_error "Cannot install cdx cron job because crontab is unavailable."
    return 1
  fi

  local cdx_path
  cdx_path="$(real_path "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")"
  if [[ ! -x "$cdx_path" ]]; then
    log_error "Cannot determine cdx path for cron entry."
    return 1
  fi

  local log_file="$HOME/.codex/cron.log"
  mkdir -p "$(dirname "$log_file")" 2>/dev/null || true

  # Random minute (0-59) and hour (0-3) unique per host, so not all hosts hit the API at once.
  local rand_minute rand_hour
  rand_minute=$(( $(cksum <<< "$(hostname)-min" | cut -d' ' -f1) % 60 ))
  rand_hour=$(( $(cksum <<< "$(hostname)-hr" | cut -d' ' -f1) % 4 ))

  local quoted_cdx_path quoted_log_file cron_command cron_line marker current_crontab filtered_crontab
  printf -v quoted_cdx_path '%q' "$cdx_path"
  printf -v quoted_log_file '%q' "$log_file"
  cron_command="${quoted_cdx_path} --cron >> ${quoted_log_file} 2>&1"
  cron_command="${cron_command//%/\\%}"
  marker="$(cron_managed_marker)"
  cron_line="${rand_minute} ${rand_hour} * * * ${cron_command} ${marker}"
  current_crontab="$(crontab -l 2>/dev/null || true)"

  if printf '%s\n' "$current_crontab" | grep -qF "$cron_line"; then
    printf '%s\n' "cdx cron job already installed."
    return 0
  fi

  filtered_crontab="$(printf '%s\n' "$current_crontab" | cron_filter_existing_entries "$cdx_path" "$quoted_cdx_path" "$marker")"

  {
    if [[ -n "$filtered_crontab" ]]; then
      printf '%s\n' "$filtered_crontab"
    fi
    printf '%s\n' "$cron_line"
  } | crontab -

  printf 'cdx cron job installed (daily at %02d:%02d). Log: %s\n' "$rand_hour" "$rand_minute" "$log_file"
}

remove_cron_job() {
  if ! command -v crontab >/dev/null 2>&1; then
    printf '%s\n' "cdx cron job not found in crontab."
    return 0
  fi

  local cdx_path quoted_cdx_path marker current_crontab filtered_crontab
  cdx_path="$(real_path "$0" 2>/dev/null || readlink -f "$0" 2>/dev/null || echo "$0")"
  printf -v quoted_cdx_path '%q' "$cdx_path"
  marker="$(cron_managed_marker)"
  current_crontab="$(crontab -l 2>/dev/null || true)"

  if ! cron_has_wrapper_entry "$current_crontab" "$cdx_path" "$quoted_cdx_path" "$marker"; then
    printf '%s\n' "cdx cron job not found in crontab."
    return 0
  fi

  filtered_crontab="$(printf '%s\n' "$current_crontab" | cron_filter_existing_entries "$cdx_path" "$quoted_cdx_path" "$marker")"
  printf '%s\n' "$filtered_crontab" | crontab -
  printf '%s\n' "cdx cron job removed."
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
  CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$url" "$json_payload" "$action_label" "$CODEX_SYNC_CA_FILE" "$CODEX_SYNC_ALLOW_INSECURE" <<'PY'
import json, os, sys

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

url = sys.argv[1]
payload_json = sys.argv[2]
action = sys.argv[3]
cafile = sys.argv[4] if len(sys.argv) > 4 else ""
allow_insecure_raw = (sys.argv[5] if len(sys.argv) > 5 else "").strip().lower()
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")

payload = json.loads(payload_json)
try:
    if "cdx_request_json" not in globals():
        raise RuntimeError("python-http-util-missing")
    os.environ["CODEX_SYNC_ALLOW_INSECURE"] = allow_insecure_raw
    data = cdx_request_json(
        "POST", url, api_key,
        cafile=cafile, payload=payload, timeout=30,
        allow_insecure_env="CODEX_SYNC_ALLOW_INSECURE",
    )
    json.dump(data, sys.stdout, separators=(",", ":"))
    sys.exit(0)
except RuntimeError as exc:
    msg = str(exc)
    if msg.startswith("http-"):
        print(f"{action} failed ({msg})", file=sys.stderr)
        sys.exit(2)
    print(f"{action} failed: {msg}", file=sys.stderr)
    sys.exit(3)
PY
}

cron_auto_update() {
  local lock_file="$HOME/.codex/.cdx_cron.lock"
  mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true

  # Non-blocking lock to prevent concurrent cron runs.
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$lock_file" 2>/dev/null || {
      printf '[%s] cron: cannot open lock file %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$lock_file"
      return 1
    }
    if ! flock -n 9 2>/dev/null; then
      printf '[%s] cron: another cron run is active; skipping.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      return 0
    fi
  else
    log_warn "flock not available; cron concurrent-run guard disabled."
  fi

  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    printf '[%s] cron: sync config missing; cannot check for updates.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  local codex_bin
  codex_bin="$(resolve_real_codex 2>/dev/null || true)"
  if [[ -z "$codex_bin" ]]; then
    printf '[%s] cron: codex binary not found on PATH.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  local local_version_raw local_version
  local_version_raw="$("$codex_bin" -V 2>/dev/null || true)"
  local_version="$(normalize_version "$local_version_raw")"

  local cron_asset_name
  cron_asset_name="$(detect_codex_asset_name 2>/dev/null)" || true
  if [[ -z "$cron_asset_name" ]]; then
    printf '[%s] cron: unsupported platform; cannot determine asset name.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    printf '[%s] cron: python3 is required for API calls.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  # Call POST /cron/check
  local check_payload
  check_payload="$(python3 -c "import json; print(json.dumps({
    'client_version': '${local_version:-unknown}',
    'wrapper_version': '${WRAPPER_VERSION:-unknown}',
    'asset_name': '${cron_asset_name}'
  }))")"

  local check_url="${CODEX_SYNC_BASE_URL}/cron/check"
  local check_response
  check_response="$(cron_do_api_call "$check_url" "$check_payload" "cron-check" 2>&1)" || {
    printf '[%s] cron: API check failed: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$check_response"
    return 1
  }

  local action target_version tag enforce_exact
  action="$(printf '%s' "$check_response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('action',''))" 2>/dev/null || true)"

  if [[ "$action" == "no_update" ]]; then
    printf '[%s] cron: no update needed (current: %s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${local_version:-unknown}"
    return 0
  fi

  if [[ "$action" == "disable" ]]; then
    printf '[%s] cron: auto-update disabled by server; removing cron job.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    remove_cron_job
    return 0
  fi

  if [[ "$action" != "update" ]]; then
    printf '[%s] cron: unexpected action "%s" from API.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action"
    return 1
  fi

  # Extract update details
  target_version="$(printf '%s' "$check_response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('target_version',''))" 2>/dev/null || true)"
  tag="$(printf '%s' "$check_response" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('data',{}).get('tag',''))" 2>/dev/null || true)"

  if [[ -z "$target_version" ]]; then
    printf '[%s] cron: update action but no target_version provided.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 1
  fi

  printf '[%s] cron: update available: %s -> %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${local_version:-unknown}" "$target_version"

  # Resolve download URL and SHA256 from GitHub releases.
  local api_releases_url="https://api.github.com/repos/openai/codex/releases"
  local tmp_payload
  tmp_payload="$(mktemp)"
  local fetch_success=0
  local remote_url="" remote_asset="" remote_sha256="" remote_tag=""

  local candidate_tags=()
  local _t
  for _t in "$tag" "$target_version" "v${target_version}" "rust-${target_version}" "rust-v${target_version}"; do
    [[ -z "$_t" ]] && continue
    local _dup=0
    local _e
    for _e in "${candidate_tags[@]-}"; do
      [[ "$_e" == "$_t" ]] && { _dup=1; break; }
    done
    (( _dup )) || candidate_tags+=("$_t")
  done

  local payload_json="" payload_raw=""
  local fresh_fields=()
  for tag_variant in "${candidate_tags[@]}"; do
    if payload_json="$(fetch_release_payload "${api_releases_url}/tags/${tag_variant}" "$cron_asset_name" 2>/dev/null)"; then
      printf '%s\n' "$payload_json" > "$tmp_payload"
      fresh_fields=()
      if payload_raw="$(read_cached_payload "$tmp_payload")"; then
        while IFS= read -r line; do
          fresh_fields+=("$line")
        done <<< "$payload_raw"
      fi
      if (( ${#fresh_fields[@]} >= 5 )); then
        remote_url="${fresh_fields[1]}"
        remote_asset="${fresh_fields[2]}"
        remote_tag="${fresh_fields[4]}"
        remote_sha256="${fresh_fields[5]:-}"
        fetch_success=1
        break
      fi
    fi
  done
  rm -f "$tmp_payload"

  if (( fetch_success == 0 )); then
    printf '[%s] cron: could not fetch release metadata for %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target_version"
    return 1
  fi

  if [[ -z "$remote_sha256" ]]; then
    printf '[%s] cron: missing checksum for %s; skipping update.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target_version"
    return 1
  fi

  if [[ -z "$remote_url" ]]; then
    printf '[%s] cron: missing download URL for %s; skipping update.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target_version"
    return 1
  fi

  # Perform the update using the existing function.
  if perform_update "$codex_bin" "$remote_url" "${remote_asset:-$cron_asset_name}" "$target_version" "$remote_sha256"; then
    printf '[%s] cron: codex updated to %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target_version"

    # Verify new version.
    local new_version_raw new_version
    new_version_raw="$("$codex_bin" -V 2>/dev/null || true)"
    new_version="$(normalize_version "$new_version_raw")"

    # Report success to API.
    local report_payload
    report_payload="$(python3 -c "import json; print(json.dumps({'client_version': '${new_version:-$target_version}'}))")"
    local report_url="${CODEX_SYNC_BASE_URL}/cron/report"
    local report_attempt report_ok=0
    for report_attempt in 1 2 3; do
      if cron_do_api_call "$report_url" "$report_payload" "cron-report" >/dev/null 2>&1; then
        report_ok=1
        break
      fi
      sleep 2
    done

    if (( report_ok == 0 )); then
      printf '[%s] cron: update report failed after retries (version: %s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${new_version:-$target_version}"
      return 1
    fi

    printf '[%s] cron: update reported (version: %s).\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${new_version:-$target_version}"
    return 0
  else
    printf '[%s] cron: update to %s failed.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$target_version"
    return 1
  fi
}

if (( CODEX_CRON_MODE )); then
  if (( CODEX_CRON_INSTALL )); then
    install_cron_job
    exit $?
  fi

  if (( CODEX_CRON_REMOVE )); then
    remove_cron_job
    exit $?
  fi

  cron_auto_update
  exit $?
fi
