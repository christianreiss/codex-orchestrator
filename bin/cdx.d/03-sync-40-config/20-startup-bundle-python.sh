startup_sync_bundle_python() {
  local base="$1"
  local api_key="$2"
  local agents_file="$3"
  local config_file="$4"
  local cafile="$5"
  local username="${6}"
  local home_path="${7}"
  local hostname="${8}"
  CODEX_SYNC_API_KEY="$api_key" CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}" CODEX_SYNC_USERNAME="$username" CODEX_SYNC_HOME="$home_path" CODEX_SYNC_HOSTNAME="$hostname" python3 - "$base" "$agents_file" "$config_file" "$cafile" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

base = (sys.argv[1] or "").rstrip("/")
agents_file = pathlib.Path(sys.argv[2]).expanduser()
config_file = pathlib.Path(sys.argv[3]).expanduser()
cafile = sys.argv[4] if len(sys.argv) > 4 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")
_cdx_api_key = api_key
_cdx_cafile = cafile
username = (os.environ.get("CODEX_SYNC_USERNAME", "") or "").strip()
home_path = (os.environ.get("CODEX_SYNC_HOME", "") or "").strip()
hostname = (os.environ.get("CODEX_SYNC_HOSTNAME", "") or "").strip()

if not base:
    print("error reason=missing-base")
    sys.exit(1)
if not api_key:
    print("error reason=missing-api-key")
    sys.exit(1)

request_json = cdx_short_request_json


def normalize_sha(value):
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    if len(value) != 64:
        return None
    if any(ch not in "0123456789abcdef" for ch in value):
        return None
    return value

atomic_write_text = cdx_atomic_write_text


def file_sha(path: pathlib.Path):
    try:
        return hashlib.sha256(path.read_bytes()).hexdigest()
    except Exception:
        return None


def apply_agents_change(block):
    status = str((block or {}).get("status") or "").strip().lower()
    remote_sha = (block or {}).get("sha256")
    remote_updated_at = (block or {}).get("updated_at")
    remote_bytes = (block or {}).get("size_bytes")
    removed = 0

    if status == "missing":
        try:
            if agents_file.exists():
                agents_file.unlink()
                removed = 1
        except Exception:
            pass
    elif status == "updated":
        content = (block or {}).get("content")
        if not isinstance(content, str):
            return {
                "status": "error",
                "state": "error",
                "reason": "agents-missing-content",
                "sha256": remote_sha,
                "updated_at": remote_updated_at,
                "bytes": remote_bytes,
                "removed": 0,
            }
        try:
            atomic_write_text(agents_file, content)
        except Exception as exc:
            return {
                "status": "error",
                "state": "error",
                "reason": f"agents-write-failed:{str(exc).replace(' ', '_')}",
                "sha256": remote_sha,
                "updated_at": remote_updated_at,
                "bytes": remote_bytes,
                "removed": 0,
            }

    return {
        "status": "ok",
        "state": status if status in ("missing", "updated", "unchanged") else "unchanged",
        "reason": "",
        "sha256": remote_sha,
        "updated_at": remote_updated_at,
        "bytes": remote_bytes,
        "removed": removed,
    }


def apply_config_change(block):
    status = str((block or {}).get("status") or "").strip().lower()
    remote_sha = (block or {}).get("sha256")
    remote_updated_at = (block or {}).get("updated_at")
    remote_bytes = (block or {}).get("size_bytes")
    removed = 0

    if status == "missing":
        try:
            if config_file.exists():
                config_file.unlink()
                removed = 1
        except Exception:
            pass
    elif status == "updated":
        content = (block or {}).get("content")
        if not isinstance(content, str):
            return {
                "status": "error",
                "state": "error",
                "reason": "config-missing-content",
                "sha256": remote_sha,
                "updated_at": remote_updated_at,
                "bytes": remote_bytes,
                "removed": 0,
            }
        try:
            atomic_write_text(config_file, content)
        except Exception as exc:
            return {
                "status": "error",
                "state": "error",
                "reason": f"config-write-failed:{str(exc).replace(' ', '_')}",
                "sha256": remote_sha,
                "updated_at": remote_updated_at,
                "bytes": remote_bytes,
                "removed": 0,
            }

    return {
        "status": "ok",
        "state": status if status in ("missing", "updated", "unchanged") else "unchanged",
        "reason": "",
        "sha256": remote_sha,
        "updated_at": remote_updated_at,
        "bytes": remote_bytes,
        "removed": removed,
    }

agents_sha = file_sha(agents_file) if agents_file.is_file() else None
config_sha = file_sha(config_file) if config_file.is_file() else None

status_payload = {
    "include_auth": False,
    "host_user": {
        "username": username,
        "hostname": hostname,
    },
    "agents": {
        "sha256": agents_sha,
    },
    "config": {
        "sha256": config_sha,
        "username": username,
        "home": home_path,
    },
}

try:
    status_resp = request_json("POST", f"{base}/sync/status", status_payload)
except Exception as exc:
    reason = str(exc).strip().replace(" ", "_")
    if reason.startswith("http-404") or reason.startswith("http-405"):
        print("fallback reason=endpoint-missing")
        sys.exit(42)
    print(f"error reason={reason}")
    sys.exit(1)

data = status_resp.get("data") if isinstance(status_resp, dict) else {}
phase = str((data or {}).get("status") or "").strip().lower()
reasons = data.get("reasons") if isinstance(data, dict) else []
if not isinstance(reasons, list):
    reasons = []

if phase == "update":
    bootstrap_payload = dict(status_payload)
    try:
        bootstrap_resp = request_json("POST", f"{base}/sync/bootstrap", bootstrap_payload)
    except Exception as exc:
        reason = str(exc).strip().replace(" ", "_")
        if reason.startswith("http-404") or reason.startswith("http-405"):
            print("fallback reason=endpoint-missing")
            sys.exit(42)
        print(f"error reason={reason}")
        sys.exit(1)
    data = bootstrap_resp.get("data") if isinstance(bootstrap_resp, dict) else {}
    reasons = data.get("reasons") if isinstance(data, dict) else reasons
    if not isinstance(reasons, list):
        reasons = []

if not isinstance(data, dict):
    print("error reason=invalid-sync-response")
    sys.exit(1)

agents_result = apply_agents_change(data.get("agents") if isinstance(data.get("agents"), dict) else {})
config_result = apply_config_change(data.get("config") if isinstance(data.get("config"), dict) else {})

if agents_result.get("status") != "ok" or config_result.get("status") != "ok":
    print(
        json.dumps(
            {
                "status": "error",
                "reason": agents_result.get("reason") or config_result.get("reason") or "sync-apply-failed",
                "phase": phase or str((data or {}).get("status") or "").strip().lower() or "ok",
                "reasons": reasons,
                "agents": agents_result,
                "config": config_result,
            },
            separators=(",", ":"),
        )
    )
    sys.exit(1)

print(
    json.dumps(
        {
            "status": "ok",
            "phase": phase or str((data or {}).get("status") or "").strip().lower() or "ok",
            "reasons": reasons,
            "agents": agents_result,
            "config": config_result,
        },
        separators=(",", ":"),
    )
)
sys.exit(0)
PY
}
