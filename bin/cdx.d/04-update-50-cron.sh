
# Cron auto-update mode: lightweight path that skips auth sync and interactive launch.
# Invoked via: cdx --cron [install|remove]

install_cron_job() {
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

  local cron_line="${rand_minute} ${rand_hour} * * * ${cdx_path} --cron >> ${log_file} 2>&1"
  local marker="cdx --cron"

  # Check if entry already exists.
  if crontab -l 2>/dev/null | grep -qF "$marker"; then
    printf '%s\n' "cdx cron job already installed."
    return 0
  fi

  # Append to existing crontab.
  ( crontab -l 2>/dev/null || true; printf '%s\n' "$cron_line" ) | crontab -
  printf '%s\n' "cdx cron job installed (daily at %02d:%02d). Log: ${log_file}" "$rand_hour" "$rand_minute"
}

remove_cron_job() {
  local marker="cdx --cron"
  if ! crontab -l 2>/dev/null | grep -qF "$marker"; then
    printf '%s\n' "cdx cron job not found in crontab."
    return 0
  fi

  crontab -l 2>/dev/null | grep -vF "$marker" | crontab -
  printf '%s\n' "cdx cron job removed."
}

cron_do_api_call() {
  local url="$1"
  local json_payload="$2"
  local action_label="$3"
  CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$url" "$json_payload" "$action_label" "$CODEX_SYNC_CA_FILE" "$CODEX_SYNC_ALLOW_INSECURE" <<'PY'
import json, os, socket, ssl, sys, urllib.error, urllib.request

if os.environ.get("CODEX_FORCE_IPV4", "").lower() in ("1", "true", "yes"):
    _orig = socket.getaddrinfo
    def _force_v4(host, port, family=0, type=0, proto=0, flags=0):
        return _orig(host, port, socket.AF_INET, type, proto, flags)
    socket.getaddrinfo = _force_v4

url = sys.argv[1]
payload_json = sys.argv[2]
action = sys.argv[3]
cafile = sys.argv[4] if len(sys.argv) > 4 else ""
allow_insecure = (sys.argv[5] if len(sys.argv) > 5 else "").strip().lower() in ("1", "true", "yes")
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")

body = payload_json.encode("utf-8")
headers = {"Content-Type": "application/json", "X-API-Key": api_key}
req = urllib.request.Request(url, data=body, headers=headers, method="POST")

contexts = [None]
if cafile:
    try:
        ctx = ssl.create_default_context(cafile=cafile)
        contexts = [ctx, None]
    except Exception:
        pass
if allow_insecure:
    try:
        ctx_ins = ssl.create_default_context()
        ctx_ins.check_hostname = False
        ctx_ins.verify_mode = ssl.CERT_NONE
        contexts.append(ctx_ins)
    except Exception:
        pass

last_err = None
for ctx in contexts:
    try:
        with urllib.request.urlopen(req, timeout=30, context=ctx) as resp:
            data = json.load(resp)
            json.dump(data, sys.stdout, separators=(",", ":"))
            sys.exit(0)
    except urllib.error.HTTPError as exc:
        msg = ""
        try:
            msg = exc.read().decode("utf-8", errors="replace")
        except Exception:
            pass
        print(f"{action} failed ({exc.code}): {msg}", file=sys.stderr)
        sys.exit(2)
    except Exception as exc:
        last_err = exc
        continue

print(f"{action} failed: {last_err}", file=sys.stderr)
sys.exit(3)
PY
}

cron_auto_update() {
  local lock_file="$HOME/.codex/.cdx_cron.lock"
  mkdir -p "$(dirname "$lock_file")" 2>/dev/null || true

  # Non-blocking lock to prevent concurrent cron runs.
  exec 9>"$lock_file"
  if ! flock -n 9; then
    printf '[%s] cron: another cron run is active; skipping.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    return 0
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
    cron_do_api_call "$report_url" "$report_payload" "cron-report" >/dev/null 2>&1 || true

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
