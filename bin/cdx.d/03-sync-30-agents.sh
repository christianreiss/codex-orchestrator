agents_sync_python() {
  local base="$1"
  local api_key="$2"
  local target_file="$3"
  local cafile="$4"
  local current_sha="$5"
  CODEX_SYNC_API_KEY="$api_key" CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}" python3 - "$base" "$target_file" "$cafile" "$current_sha" <<'PY'
import hashlib, json, os, pathlib, sys

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

base = (sys.argv[1] or "").rstrip("/")
target = pathlib.Path(sys.argv[2]).expanduser()
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
current_sha = (sys.argv[4] or "").strip() if len(sys.argv) > 4 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")
_cdx_api_key = api_key
_cdx_cafile = cafile

request_json = cdx_short_request_json
atomic_write_text = cdx_atomic_write_text


if not base:
    print("error reason=missing-base")
    sys.exit(1)
if not api_key:
    print("error reason=missing-api-key")
    sys.exit(1)

payload = {}
if current_sha and len(current_sha) == 64:
    payload["sha256"] = current_sha

try:
    resp = request_json("POST", f"{base}/agents/retrieve", payload)
except Exception as exc:  # noqa: BLE001
    print(f"error reason={str(exc).replace(' ', '_')}")
    sys.exit(1)

data = resp.get("data") if isinstance(resp, dict) else {}
status = (data or {}).get("status")
sha = (data or {}).get("sha256") or ""
content = (data or {}).get("content")
updated_at = (data or {}).get("updated_at") or ""
size_bytes = data.get("size_bytes") if isinstance(data, dict) else None

if status == "missing":
    removed = 0
    try:
        if target.exists():
            target.unlink()
            removed = 1
    except Exception:
        pass
    print(f"ok status=missing removed={removed}")
    sys.exit(0)

if status == "unchanged":
    print(f"ok status=unchanged sha256={sha}")
    sys.exit(0)

if status == "updated":
    if not isinstance(content, str):
        print("error reason=missing-content")
        sys.exit(1)
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(target, content)
    except Exception as exc:  # noqa: BLE001
        print(f"error reason=write-failed:{str(exc).replace(' ', '_')}")
        sys.exit(1)
    length = len(content.encode("utf-8"))
    size_label = size_bytes if isinstance(size_bytes, int) else length
    safe_updated = str(updated_at).replace(" ", "_")
    print(f"ok status=updated sha256={sha} bytes={size_label} updated_at={safe_updated}")
    sys.exit(0)

print(f"error reason=unknown-status:{status}")
sys.exit(1)
PY
}

sync_agents_pull() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    AGENTS_SYNC_STATUS="missing-config"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    AGENTS_SYNC_STATUS="no-python"
    if ((SYNC_WARNED_NO_PYTHON == 0)); then
      log_warn "python3 is required for AGENTS.md sync; skipping."
      SYNC_WARNED_NO_PYTHON=1
    fi
    return 1
  fi
  local current_sha=""
  if [[ -f "$AGENTS_PATH" ]]; then
    current_sha="$(
      python3 - "$AGENTS_PATH" <<'PY'
import hashlib, pathlib, sys
path = pathlib.Path(sys.argv[1])
try:
    print(hashlib.sha256(path.read_bytes()).hexdigest())
except Exception:
    pass
PY
    )"
  fi
  local summary status_code
  set +e
  summary="$(agents_sync_python "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_API_KEY" "$AGENTS_PATH" "$CODEX_SYNC_CA_FILE" "$current_sha")"
  status_code=$?
  set -e
  AGENTS_SYNC_STATUS="error"
  AGENTS_STATE=""
  AGENTS_REMOTE_SHA=""
  AGENTS_REMOTE_UPDATED_AT=""
  AGENTS_REMOTE_BYTES=""
  AGENTS_REMOVED=0
  if ((status_code != 0)); then
    local reason=""
    if [[ "$summary" == error\ reason=* ]]; then
      reason="${summary#error reason=}"
    fi
    if [[ "$reason" == http-5* ]] || [[ "$reason" == request_failed* ]]; then
      AGENTS_SYNC_STATUS="offline"
      AGENTS_SYNC_REASON="$reason"
    else
      AGENTS_SYNC_STATUS="error"
      AGENTS_SYNC_REASON="$reason"
    fi
    return 1
  fi
  AGENTS_SYNC_STATUS="${summary%% *}"
  AGENTS_SYNC_REASON=""
  local part
  for part in $summary; do
    case "$part" in
      status=*) AGENTS_STATE="${part#status=}" ;;
      sha256=*) AGENTS_REMOTE_SHA="${part#sha256=}" ;;
      updated_at=*) AGENTS_REMOTE_UPDATED_AT="${part#updated_at=}" ;;
      bytes=*) AGENTS_REMOTE_BYTES="${part#bytes=}" ;;
      removed=*) AGENTS_REMOVED="${part#removed=}" ;;
    esac
  done
  return 0
}
