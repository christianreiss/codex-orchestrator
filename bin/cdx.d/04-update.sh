
fetch_release_payload() {
  local api_url="$1"
  local wanted_asset="$2"
  CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$api_url" "$wanted_asset" <<'PY'
import json, os, socket, sys, time, urllib.request
if os.environ.get("CODEX_FORCE_IPV4", "").lower() in ("1", "true", "yes"):
    _orig_getaddrinfo = socket.getaddrinfo
    def _force_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
    socket.getaddrinfo = _force_getaddrinfo
url = sys.argv[1]
wanted = sys.argv[2]
headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "codex-wrapper-update-check"
}
try:
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=15) as resp:
        data = json.load(resp)
except Exception as exc:  # noqa: BLE001
    print(f"error: {exc}", file=sys.stderr)
    sys.exit(1)
name = data.get("name") or data.get("tag_name") or ""
assets = data.get("assets") or []
asset = None
if wanted:
    for candidate in assets:
        if candidate.get("name") == wanted:
            asset = candidate
            break
if asset is None and not wanted:
    for candidate in assets:
        if candidate.get("name") == "codex":
            asset = candidate
            break
if asset is None:
    if wanted:
        print(f"error: could not find release asset {wanted}", file=sys.stderr)
    else:
        print("error: could not find a matching release asset", file=sys.stderr)
    sys.exit(2)
payload = {
    "timestamp": int(time.time()),
    "version": name,
    "tag": data.get("tag_name") or "",
    "asset_name": asset.get("name", ""),
    "download_url": asset.get("browser_download_url", ""),
    "sha256": ""
}
digest = asset.get("digest")
if isinstance(digest, str) and digest.startswith("sha256:"):
    payload["sha256"] = digest.split(":", 1)[1].strip()
json.dump(payload, sys.stdout, separators=(",", ":"))
PY
}

read_cached_payload() {
  local cache_file="$1"
  python3 - "$cache_file" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('version', ''))
print(data.get('download_url', ''))
print(data.get('asset_name', ''))
print(data.get('timestamp', 0))
print(data.get('tag', ''))
print(data.get('sha256', ''))
PY
}

perform_update() (
  set -euo pipefail
  local target_path="$1"
  local url="$2"
  local asset_name="$3"
  local new_version="$4"
  local expected_sha="$5"
  local tmpdir
  tmpdir="$(mktemp -d)"
  trap 'rm -rf "$tmpdir"' EXIT
  if [[ -z "$expected_sha" ]]; then
    log_error "Missing trusted checksum for Codex ${new_version}"
    exit 1
  fi
  log_info "Downloading Codex ${new_version}"
  local asset_file="$tmpdir/asset"
  local curl_args=(-fsSL)
  if [[ "$CODEX_FORCE_IPV4" == "1" ]]; then
    curl_args+=("-4")
  fi
  if ! curl "${curl_args[@]}" "$url" -o "$asset_file"; then
    log_error "Download failed from $url"
    exit 1
  fi
  local downloaded_sha=""
  downloaded_sha="$(sha256_file "$asset_file" 2>/dev/null || true)"
  if [[ -z "$downloaded_sha" || "$downloaded_sha" != "$expected_sha" ]]; then
    log_error "Checksum mismatch for Codex ${new_version} (expected ${expected_sha}, got ${downloaded_sha:-missing})"
    exit 1
  fi
  local extracted="$asset_file"
  case "$asset_name" in
    *.tar.gz)
      tar -xzf "$asset_file" -C "$tmpdir"
      # pick the first executable named codex*
      extracted="$(find "$tmpdir" -type f -name 'codex*' ! -name 'asset' | head -n1)"
      ;;
    *.zip)
      if ! command -v unzip >/dev/null 2>&1; then
        log_error "unzip is required to handle $asset_name"
        exit 1
      fi
      unzip -q "$asset_file" -d "$tmpdir"
      extracted="$(find "$tmpdir" -type f -name 'codex*' | head -n1)"
      ;;
  esac
  if [[ -z "$extracted" || ! -f "$extracted" ]]; then
    log_error "Unable to locate Codex binary inside downloaded asset"
    exit 1
  fi
  chmod +x "$extracted"
  local target_dir
  target_dir="$(dirname "$target_path")"
  if [[ ! -d "$target_dir" ]]; then
    log_error "Target directory $target_dir does not exist"
    exit 1
  fi
  if [[ -w "$target_dir" ]]; then
    log_info "Installing Codex into $target_path"
    install -m 755 "$extracted" "$target_path"
  else
    if (( CAN_SUDO )); then
      log_info "Installing Codex into $target_path with sudo -n"
      $SUDO_BIN install -m 755 "$extracted" "$target_path"
    else
      log_warn "Insufficient permissions to install Codex into $target_path (no sudo)."
      exit 1
    fi
  fi
  log_info "Codex updated to ${new_version}"
)
