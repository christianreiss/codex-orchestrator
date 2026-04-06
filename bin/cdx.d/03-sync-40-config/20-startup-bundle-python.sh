startup_sync_bundle_python() {
  local base="$1"
  local api_key="$2"
  local agents_file="$3"
  local config_file="$4"
  local cafile="$5"
  local username="${6}"
  local home_path="${7}"
  local hostname="${8}"
  local include_auth="${9:-0}"
  local auth_file="${10:-$HOME/.codex/auth.json}"
  CODEX_SYNC_API_KEY="$api_key" \
    CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}" \
    CODEX_SYNC_USERNAME="$username" \
    CODEX_SYNC_HOME="$home_path" \
    CODEX_SYNC_HOSTNAME="$hostname" \
    CODEX_SYNC_INCLUDE_AUTH="$include_auth" \
    CODEX_SYNC_AUTH_FILE="$auth_file" \
    CODEX_SYNC_CLIENT_VERSION="${LOCAL_VERSION:-unknown}" \
    CODEX_SYNC_WRAPPER_VERSION="${WRAPPER_VERSION:-unknown}" \
    CODEX_INSECURE_SESSION_STARTED_AT="${INSECURE_SESSION_STARTED_AT:-}" \
    python3 - "$base" "$agents_file" "$config_file" "$cafile" <<'PY'
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
include_auth = (os.environ.get("CODEX_SYNC_INCLUDE_AUTH", "") or "").strip().lower() in ("1", "true", "yes", "on")
auth_file_env = (os.environ.get("CODEX_SYNC_AUTH_FILE", "") or "").strip()
auth_file = pathlib.Path(auth_file_env).expanduser() if auth_file_env else pathlib.Path.home() / ".codex" / "auth.json"
client_version = (os.environ.get("CODEX_SYNC_CLIENT_VERSION", "") or "").strip() or "unknown"
wrapper_version = (os.environ.get("CODEX_SYNC_WRAPPER_VERSION", "") or "").strip() or "unknown"
session_started_at = (os.environ.get("CODEX_INSECURE_SESSION_STARTED_AT", "") or "").strip()
installation_id = (os.environ.get("CODEX_INSTALLATION_ID", "") or "").strip()

if not base:
    print("error reason=missing-base")
    sys.exit(1)
if not api_key:
    print("error reason=missing-api-key")
    sys.exit(1)

request_json = cdx_short_request_json


def default_auth():
    return {"last_refresh": "2000-01-01T00:00:00Z", "auths": {}}


def load_auth_candidate(path: pathlib.Path):
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default_auth()
    if not isinstance(data, dict) or "last_refresh" not in data:
        return default_auth()
    return data


def canonical_json(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


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


def normalize_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return None


def window(value):
    return value if isinstance(value, dict) else {}


def record_versions(vblock):
    out = {}
    if isinstance(vblock, dict):
        cv = vblock.get("client_version")
        if isinstance(cv, str) and cv.strip():
            out["client_version"] = cv.strip()
        cvs = vblock.get("client_version_source")
        if isinstance(cvs, str) and cvs.strip():
            out["client_version_source"] = cvs.strip()
        cvx = vblock.get("client_version_enforce_exact")
        if isinstance(cvx, bool):
            out["client_version_enforce_exact"] = cvx
        wv = vblock.get("wrapper_version")
        if isinstance(wv, str) and wv.strip():
            out["wrapper_version"] = wv.strip()
        ws = vblock.get("wrapper_sha256")
        if isinstance(ws, str) and ws.strip():
            out["wrapper_sha256"] = ws.strip()
        wu = vblock.get("wrapper_url")
        if isinstance(wu, str) and wu.strip():
            out["wrapper_url"] = wu.strip()
        rs = vblock.get("runner_state")
        if isinstance(rs, str) and rs.strip():
            out["runner_state"] = rs.strip()
        rlo = vblock.get("runner_last_ok")
        if isinstance(rlo, str) and rlo.strip():
            out["runner_last_ok"] = rlo.strip()
        rlf = vblock.get("runner_last_fail")
        if isinstance(rlf, str) and rlf.strip():
            out["runner_last_fail"] = rlf.strip()
        rlc = vblock.get("runner_last_check")
        if isinstance(rlc, str) and rlc.strip():
            out["runner_last_check"] = rlc.strip()
        re_val = vblock.get("runner_enabled")
        if isinstance(re_val, bool):
            out["runner_enabled"] = re_val
        aue = vblock.get("auto_update_enabled")
        if isinstance(aue, bool):
            out["auto_update_enabled"] = aue
        silent = vblock.get("cdx_silent")
        if isinstance(silent, bool):
            out["cdx_silent"] = silent
        inst = vblock.get("installation_id")
        if isinstance(inst, str) and inst.strip():
            out["installation_id"] = inst.strip()
    return out


def normalize_auth_summary(block, current_auth):
    if not isinstance(block, dict):
        return {"status": "error", "reason": "missing-auth-block"}

    payload_data = block
    status = str(payload_data.get("status") or "").strip().lower()
    if not status:
        status = "upload_required"

    versions_out = record_versions(payload_data.get("versions", {}))
    server_installation = versions_out.get("installation_id")
    if server_installation and installation_id and server_installation != installation_id:
        return {"status": "error", "reason": "installation-mismatch"}

    host_info = payload_data.get("host") if isinstance(payload_data.get("host"), dict) else {}
    host_secure = normalize_bool(host_info.get("secure")) if isinstance(host_info, dict) else None
    host_vip = normalize_bool(host_info.get("vip")) if isinstance(host_info, dict) else None
    host_lane_preference = None
    if isinstance(host_info, dict):
        lane_pref_raw = host_info.get("lane_preference")
        if isinstance(lane_pref_raw, str):
            lane_pref = lane_pref_raw.strip().lower()
            if lane_pref in ("normal", "spark"):
                host_lane_preference = lane_pref

    chatgpt_usage_raw = payload_data.get("chatgpt_usage")
    chatgpt_usage = chatgpt_usage_raw if isinstance(chatgpt_usage_raw, dict) else {}

    normal_window = chatgpt_usage.get("normal_window") if isinstance(chatgpt_usage.get("normal_window"), dict) else {}
    spark_window = chatgpt_usage.get("spark_window") if isinstance(chatgpt_usage.get("spark_window"), dict) else {}
    normal_primary_window = window(normal_window.get("primary_window"))
    normal_secondary_window = window(normal_window.get("secondary_window"))
    if not normal_primary_window and not normal_secondary_window:
        normal_primary_window = window(chatgpt_usage.get("primary_window"))
        normal_secondary_window = window(chatgpt_usage.get("secondary_window"))
    spark_primary_window = window(spark_window.get("primary_window"))
    spark_secondary_window = window(spark_window.get("secondary_window"))

    active_lane = "normal"
    active_lane_raw = chatgpt_usage.get("active_quota_lane")
    if isinstance(active_lane_raw, str) and active_lane_raw.strip().lower() in ("normal", "spark"):
        active_lane = active_lane_raw.strip().lower()
    elif host_lane_preference in ("normal", "spark"):
        active_lane = host_lane_preference
    else:
        model_override = host_info.get("model_override") if isinstance(host_info, dict) else None
        if isinstance(model_override, str) and model_override.strip():
            active_lane = "spark" if "spark" in model_override.strip().lower() else "normal"

    if active_lane == "spark" and not (spark_primary_window or spark_secondary_window):
        active_lane = "normal"

    active_primary_window = spark_primary_window if active_lane == "spark" else normal_primary_window
    active_secondary_window = spark_secondary_window if active_lane == "spark" else normal_secondary_window

    auth_to_write = None
    normalized_status = status
    did_store = False
    if status == "valid":
        auth_to_write = current_auth
    elif status == "outdated":
        auth_to_write = payload_data.get("auth") or current_auth
        lr = payload_data.get("canonical_last_refresh") or payload_data.get("last_refresh")
        if isinstance(auth_to_write, dict) and isinstance(lr, str):
            auth_to_write["last_refresh"] = lr
    elif status in ("updated", "unchanged"):
        auth_to_write = payload_data.get("auth") or current_auth
        lr = payload_data.get("canonical_last_refresh") or payload_data.get("last_refresh")
        if isinstance(auth_to_write, dict) and isinstance(lr, str):
            auth_to_write["last_refresh"] = lr
        normalized_status = "valid"
        did_store = True
    elif status in ("missing", "upload_required"):
        pass
    else:
        normalized_status = "upload_required"

    if auth_to_write is not None and not isinstance(auth_to_write, dict):
        auth_to_write = current_auth

    if auth_to_write is not None:
        try:
            atomic_write_text(auth_file, json.dumps(auth_to_write, indent=2) + "\n", mode=0o600)
        except Exception as exc:
            return {"status": "error", "reason": f"auth-write-failed:{str(exc).replace(' ', '_')}"}

    return {
        "status": "ok",
        "summary": {
            "versions": versions_out,
            "auth_status": normalized_status or "unknown",
            "auth_action": ("store" if (did_store and normalized_status == "valid") else normalized_status or "unknown"),
            "auth_message": (
                "uploaded current auth" if (did_store and normalized_status == "valid") else
                "synced (no change)" if normalized_status == "valid" else
                "updated from api" if normalized_status == "outdated" else
                normalized_status
            ),
            "host_secure": host_secure,
            "host_lane_preference": host_lane_preference,
            "chatgpt_status": chatgpt_usage.get("status"),
            "chatgpt_plan": chatgpt_usage.get("plan_type"),
            "chatgpt_next": chatgpt_usage.get("next_eligible_at"),
            "chatgpt_active_quota_lane": active_lane,
            "chatgpt_primary_used": active_primary_window.get("used_percent"),
            "chatgpt_primary_limit": active_primary_window.get("limit_seconds"),
            "chatgpt_primary_reset_after": active_primary_window.get("reset_after_seconds"),
            "chatgpt_primary_reset_at": active_primary_window.get("reset_at"),
            "chatgpt_secondary_used": active_secondary_window.get("used_percent"),
            "chatgpt_secondary_limit": active_secondary_window.get("limit_seconds"),
            "chatgpt_secondary_reset_after": active_secondary_window.get("reset_after_seconds"),
            "chatgpt_secondary_reset_at": active_secondary_window.get("reset_at"),
            "chatgpt_normal_primary_used": normal_primary_window.get("used_percent"),
            "chatgpt_normal_primary_limit": normal_primary_window.get("limit_seconds"),
            "chatgpt_normal_primary_reset_after": normal_primary_window.get("reset_after_seconds"),
            "chatgpt_normal_primary_reset_at": normal_primary_window.get("reset_at"),
            "chatgpt_normal_secondary_used": normal_secondary_window.get("used_percent"),
            "chatgpt_normal_secondary_limit": normal_secondary_window.get("limit_seconds"),
            "chatgpt_normal_secondary_reset_after": normal_secondary_window.get("reset_after_seconds"),
            "chatgpt_normal_secondary_reset_at": normal_secondary_window.get("reset_at"),
            "chatgpt_spark_primary_used": spark_primary_window.get("used_percent"),
            "chatgpt_spark_primary_limit": spark_primary_window.get("limit_seconds"),
            "chatgpt_spark_primary_reset_after": spark_primary_window.get("reset_after_seconds"),
            "chatgpt_spark_primary_reset_at": spark_primary_window.get("reset_at"),
            "chatgpt_spark_secondary_used": spark_secondary_window.get("used_percent"),
            "chatgpt_spark_secondary_limit": spark_secondary_window.get("limit_seconds"),
            "chatgpt_spark_secondary_reset_after": spark_secondary_window.get("reset_after_seconds"),
            "chatgpt_spark_secondary_reset_at": spark_secondary_window.get("reset_at"),
            "chatgpt_spark_limit_name": chatgpt_usage.get("spark_limit_name"),
            "chatgpt_spark_metered_feature": chatgpt_usage.get("spark_metered_feature"),
            "chatgpt_daily_used_percent": chatgpt_usage.get("daily_used_percent"),
            "chatgpt_daily_baseline_at": chatgpt_usage.get("daily_baseline_at"),
            "api_calls": payload_data.get("api_calls"),
            "token_usage_month": payload_data.get("token_usage_month"),
            "quota_hard_fail": payload_data.get("quota_hard_fail"),
            "quota_limit_percent": payload_data.get("quota_limit_percent"),
            "quota_week_partition": payload_data.get("quota_week_partition"),
            "cdx_silent": payload_data.get("cdx_silent"),
            "host_vip": host_vip,
        },
    }


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
current_auth = load_auth_candidate(auth_file) if include_auth else None
auth_digest = None
if include_auth and isinstance(current_auth, dict):
    auth_digest = hashlib.sha256(canonical_json(current_auth).encode("utf-8")).hexdigest()

status_payload = {
    "include_auth": include_auth,
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
if include_auth and isinstance(current_auth, dict):
    status_payload["auth"] = {
        "last_refresh": current_auth.get("last_refresh") or "2000-01-01T00:00:00Z",
        "digest": auth_digest,
    }
    status_payload["client_version"] = client_version
    if wrapper_version and wrapper_version != "unknown":
        status_payload["wrapper_version"] = wrapper_version
    if session_started_at:
        status_payload["session_started_at"] = session_started_at
    if installation_id:
        status_payload["installation_id"] = installation_id

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
    if include_auth and isinstance(current_auth, dict):
        bootstrap_payload["auth_candidate"] = current_auth
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
auth_result = {"status": "skip", "summary": None}
if include_auth:
    auth_result = normalize_auth_summary(
        data.get("auth") if isinstance(data.get("auth"), dict) else None,
        current_auth if isinstance(current_auth, dict) else default_auth(),
    )

if (
    agents_result.get("status") != "ok"
    or config_result.get("status") != "ok"
    or auth_result.get("status") not in ("ok", "skip")
):
    print(
        json.dumps(
            {
                "status": "error",
                "reason": (
                    agents_result.get("reason")
                    or config_result.get("reason")
                    or auth_result.get("reason")
                    or "sync-apply-failed"
                ),
                "phase": phase or str((data or {}).get("status") or "").strip().lower() or "ok",
                "reasons": reasons,
                "agents": agents_result,
                "config": config_result,
                "auth": auth_result.get("summary"),
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
            "auth": auth_result.get("summary"),
        },
        separators=(",", ":"),
    )
)
sys.exit(0)
PY
}
