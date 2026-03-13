sync_auth_with_api() {
  local phase="$1"
  local read_only="${2:-0}"
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    log_error "Sync config missing API key or base URL; download a fresh cdx wrapper from the server."
    AUTH_PULL_STATUS="missing-config"
    AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_error "python3 is required for Codex auth sync; install python3 and retry."
    exit 1
  fi
  if (( read_only == 0 )) && (( HOST_USERS_FETCHED == 0 )); then
    record_host_user_with_api || true
  fi
  local auth_path="$HOME/.codex/auth.json"
  AUTH_PULL_REASON=""
  # Drop a malformed local auth.json so we can hydrate cleanly.
  if (( read_only == 0 )) && [[ -f "$auth_path" ]] && ! validate_auth_json_file "$auth_path"; then
    rm -f "$auth_path"
  fi
  local phase_label
  phase_label="${phase:-sync}"
  # No chatty per-step auth logging; final summary will capture the outcome.
  local api_output=""
  local api_status=0
  local offline_reason=""
  local deny_reason=""
  local wait_logged=0
  while true; do
    offline_reason=""
    deny_reason=""
    if api_output="$(CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" CODEX_INSECURE_SESSION_STARTED_AT="$INSECURE_SESSION_STARTED_AT" CODEX_SYNC_READ_ONLY="$read_only" python3 - "$CODEX_SYNC_BASE_URL" "$auth_path" "$CODEX_SYNC_CA_FILE" "$LOCAL_VERSION" "$WRAPPER_VERSION" <<'PY'
import hashlib, json, os, pathlib, sys, urllib.error, urllib.request

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

base = (sys.argv[1] or "").rstrip("/")
path = pathlib.Path(sys.argv[2]).expanduser()
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
client_version = sys.argv[4] if len(sys.argv) > 4 else "unknown"
wrapper_version = sys.argv[5] if len(sys.argv) > 5 else "unknown"
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")
installation_id = (os.environ.get("CODEX_INSTALLATION_ID", "") or "").strip()
session_started_at = (os.environ.get("CODEX_INSECURE_SESSION_STARTED_AT", "") or "").strip()
read_only = (os.environ.get("CODEX_SYNC_READ_ONLY", "") or "").strip().lower() in ("1", "true", "yes", "on")

if not base:
    print("Sync API base URL missing", file=sys.stderr)
    sys.exit(1)


def default_auth():
    return {"last_refresh": "2000-01-01T00:00:00Z", "auths": {}}


def load_auth():
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default_auth()
    if not isinstance(data, dict) or "last_refresh" not in data:
        return default_auth()
    return data


def canonical_json(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def atomic_write_text(target, content, mode=None):
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(target.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    tmp.replace(target)
    if mode is not None:
        try:
            os.chmod(target, mode)
        except PermissionError:
            pass


def parse_error_body(body: str):
    msg = body
    details = {}
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            msg = parsed.get("message", body)
            details = parsed.get("details", {}) or {}
    except Exception:
        pass
    return msg, details


def normalize_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return None


def fail_with_http(exc: urllib.error.HTTPError, action: str):
    body = exc.read().decode("utf-8", "ignore")
    msg, details = parse_error_body(body)
    msg_lower = msg.lower() if isinstance(msg, str) else ""
    detail_code = ""
    if isinstance(details, dict):
        detail_code = str(details.get("code") or "").lower()
    expected_ip = details.get("expected_ip") if isinstance(details, dict) else None
    received_ip = details.get("received_ip") if isinstance(details, dict) else None
    extra = ""
    if expected_ip or received_ip:
        parts = []
        if expected_ip:
            parts.append(f"expected {expected_ip}")
        if received_ip:
            parts.append(f"received {received_ip}")
        extra = " (" + ", ".join(parts) + ")"
    if exc.code == 401:
        if isinstance(msg, str) and "Invalid API key" in msg:
            sys.exit(10)
        if isinstance(msg, str) and "API key missing" in msg:
            sys.exit(21)
        sys.exit(22)
    if exc.code == 423:
        if "approval pending" in msg_lower:
            print("insecure host approval pending", file=sys.stderr)
            sys.exit(25)
        if "approval denied" in msg_lower:
            print("insecure host approval denied", file=sys.stderr)
            sys.exit(26)
        sys.exit(23)
    if exc.code == 403:
        if "approval denied" in msg_lower:
            print("insecure host approval denied", file=sys.stderr)
            sys.exit(26)
        if "host is disabled" in msg_lower:
            sys.exit(11)
        if detail_code == "insecure_api_disabled" or "insecure host api access disabled" in msg_lower:
            print("insecure host API access disabled", file=sys.stderr)
            sys.exit(24)
        if detail_code == "reverse_dns_mismatch" or "reverse dns" in msg_lower:
            print("denied:reverse_dns_mismatch")
            sys.exit(27)
        if "not allowed from this IP" in msg or expected_ip or received_ip:
            print(f"{action} denied (IP bound){extra}", file=sys.stderr)
            sys.exit(12)
        sys.exit(23)
    if exc.code == 503 and "disabled" in msg.lower():
        print("api disabled", file=sys.stderr)
        sys.exit(40)
    print(f"{action} failed ({exc.code}): {msg}{extra}", file=sys.stderr)
    sys.exit(2)


def post_json(url: str, payload: dict, action: str):
    body = canonical_json(payload).encode("utf-8")
    headers = {"Content-Type": "application/json", "X-API-Key": api_key}
    try:
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    except Exception as exc:  # noqa: BLE001
        print(f"{action} failed: {exc}", file=sys.stderr)
        sys.exit(3)
    contexts = cdx_build_ssl_contexts(cafile) if "cdx_build_ssl_contexts" in globals() else [None]
    last_err = None
    offline_reason = ""
    for ctx in contexts:
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            if 500 <= exc.code < 600:
                offline_reason = f"http-{exc.code}"
                last_err = exc
                continue
            fail_with_http(exc, action)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if isinstance(exc, urllib.error.URLError):
                reason_val = getattr(exc, "reason", None)
                offline_reason = str(reason_val or exc)
            continue
    if offline_reason:
        safe_reason = offline_reason.replace("\n", " ").strip()
        print(f"offline:{safe_reason}")
        sys.exit(3)
    print(f"{action} failed: {last_err}", file=sys.stderr)
    sys.exit(3)


current = load_auth()
auth_json = canonical_json(current)
auth_sha = hashlib.sha256(auth_json.encode("utf-8")).hexdigest()

retrieve_payload = {
    "command": "retrieve",
    "last_refresh": current.get("last_refresh") or "2000-01-01T00:00:00Z",
    "digest": auth_sha,
    "client_version": client_version or "unknown",
}
if wrapper_version and wrapper_version != "unknown":
    retrieve_payload["wrapper_version"] = wrapper_version
if installation_id:
    retrieve_payload["installation_id"] = installation_id

retrieve_data = post_json(f"{base}/auth", retrieve_payload, "auth retrieve")
payload_data = retrieve_data.get("data") if isinstance(retrieve_data, dict) else {}
status = (payload_data or {}).get("status")
versions_block = payload_data.get("versions") if isinstance(payload_data, dict) else {}
canonical_digest = payload_data.get("canonical_digest") or payload_data.get("digest")
auth_to_write = None
chatgpt_usage_raw = payload_data.get("chatgpt_usage") if isinstance(payload_data, dict) else {}
chatgpt_usage = chatgpt_usage_raw if isinstance(chatgpt_usage_raw, dict) else {}
host_info = payload_data.get("host") if isinstance(payload_data, dict) else {}
host_secure = normalize_bool(host_info.get("secure")) if isinstance(host_info, dict) else None
host_vip = normalize_bool(host_info.get("vip")) if isinstance(host_info, dict) else None
host_lane_preference = None
if isinstance(host_info, dict):
    lane_pref_raw = host_info.get("lane_preference")
    if isinstance(lane_pref_raw, str):
        lane_pref = lane_pref_raw.strip().lower()
        if lane_pref in ("normal", "spark"):
            host_lane_preference = lane_pref


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
        re = vblock.get("runner_enabled")
        if isinstance(re, bool):
            out["runner_enabled"] = re
        silent = vblock.get("cdx_silent")
        if isinstance(silent, bool):
            out["cdx_silent"] = silent
        inst = vblock.get("installation_id")
        if isinstance(inst, str) and inst.strip():
            out["installation_id"] = inst.strip()
    return out


def window(value):
    return value if isinstance(value, dict) else {}


versions_out = record_versions(versions_block)
if versions_out.get("client_version"):
    SYNC_REMOTE_CLIENT_VERSION = versions_out.get("client_version")
if versions_out.get("wrapper_version"):
    SYNC_REMOTE_WRAPPER_VERSION = versions_out.get("wrapper_version")
if versions_out.get("wrapper_sha256"):
    SYNC_REMOTE_WRAPPER_SHA256 = versions_out.get("wrapper_sha256")
server_installation = versions_out.get("installation_id")
if server_installation and installation_id and server_installation != installation_id:
    print("Installation ID mismatch; wrapper belongs to a different server", file=sys.stderr)
    sys.exit(42)
if versions_out.get("wrapper_url"):
    SYNC_REMOTE_WRAPPER_URL = versions_out.get("wrapper_url")

normal_window = chatgpt_usage.get("normal_window") if isinstance(chatgpt_usage.get("normal_window"), dict) else {}
spark_window = chatgpt_usage.get("spark_window") if isinstance(chatgpt_usage.get("spark_window"), dict) else {}
normal_primary_window = window(normal_window.get("primary_window"))
normal_secondary_window = window(normal_window.get("secondary_window"))
if not normal_primary_window and not normal_secondary_window:
    # Backward compatibility with older API payloads.
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

if status == "valid":
    auth_to_write = current
elif status == "outdated":
    auth_to_write = payload_data.get("auth") or current
    lr = payload_data.get("canonical_last_refresh") or payload_data.get("last_refresh")
    if isinstance(lr, str):
        auth_to_write["last_refresh"] = lr
elif status in ("missing", "upload_required"):
    pass
else:
    status = "upload_required"

did_store = False
if (not read_only) and status in ("missing", "upload_required"):
    store_payload = {
        "command": "store",
        "auth": current,
        "client_version": client_version or "unknown",
    }
    if session_started_at:
        store_payload["session_started_at"] = session_started_at
    if canonical_digest:
        store_payload["digest"] = canonical_digest
    if wrapper_version and wrapper_version != "unknown":
        store_payload["wrapper_version"] = wrapper_version
    if installation_id:
        store_payload["installation_id"] = installation_id
    update_data = post_json(f"{base}/auth", store_payload, "auth store")
    payload_data = update_data.get("data") if isinstance(update_data, dict) else {}
    store_status = (payload_data or {}).get("status")
    if isinstance(store_status, str):
        normalized_status = store_status.strip().lower()
        if normalized_status in ("updated", "unchanged"):
            status = "valid"
        elif normalized_status:
            status = normalized_status
    versions_out = record_versions(payload_data.get("versions", {})) or versions_out
    host_info = payload_data.get("host") if isinstance(payload_data, dict) else host_info
    host_vip = normalize_bool(host_info.get("vip")) if isinstance(host_info, dict) else host_vip
    host_secure = normalize_bool(host_info.get("secure")) if isinstance(host_info, dict) else host_secure
    server_installation = versions_out.get("installation_id")
    if server_installation and installation_id and server_installation != installation_id:
        print("Installation ID mismatch; wrapper belongs to a different server", file=sys.stderr)
        sys.exit(42)
    auth_to_write = payload_data.get("auth") or current
    lr = payload_data.get("canonical_last_refresh") or payload_data.get("last_refresh")
    if isinstance(lr, str):
        auth_to_write["last_refresh"] = lr
    did_store = True

if not isinstance(auth_to_write, dict):
    auth_to_write = current

if not read_only:
    atomic_write_text(path, json.dumps(auth_to_write, indent=2) + "\n", mode=0o600)

# Surface versions and auth outcome to caller via stdout as JSON
print(
    json.dumps(
        {
            "versions": versions_out,
            "auth_status": status or "unknown",
            "auth_action": ("store" if (did_store and status == "valid") else status or "unknown"),
            "auth_message": (
                "retrieved metadata (read-only)" if read_only else
                "uploaded current auth" if (did_store and status == "valid") else
                "synced (no change)" if status == "valid" else
                "updated from api" if status == "outdated" else
                status
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
        separators=(",", ":"),
    )
)
PY
  )"; then
      log_debug "auth api output: ${api_output}"
      local versions_json
      versions_json="$api_output"
      if [[ -n "$versions_json" ]] && command -v python3 >/dev/null 2>&1; then
        local parsed
        parsed="$(VJSON="$versions_json" python3 - <<'PY'
import json, os, re, sys
data = os.environ.get("VJSON", "")
try:
    parsed = json.loads(data)
except Exception:
    sys.exit(0)
if not isinstance(parsed, dict):
    sys.exit(0)
versions = parsed.get("versions")
if not isinstance(versions, dict):
    sys.exit(0)
cv = versions.get("client_version")
cvs = versions.get("client_version_source")
cvx = versions.get("client_version_enforce_exact")
wv = versions.get("wrapper_version")
ws = versions.get("wrapper_sha256")
wu = versions.get("wrapper_url")
if isinstance(cv, str) and cv.strip():
    print(f"cv={cv.strip()}")
if isinstance(cvs, str) and cvs.strip():
    print(f"cvs={cvs.strip()}")
if isinstance(cvx, bool):
    print("cvx=1" if cvx else "cvx=0")
if isinstance(wv, str) and wv.strip():
    print(f"wv={wv.strip()}")
if isinstance(ws, str) and ws.strip():
    print(f"ws={ws.strip()}")
if isinstance(wu, str) and wu.strip():
    print(f"wu={wu.strip()}")
rs = versions.get("runner_state")
if isinstance(rs, str) and rs.strip():
    print(f"rs={rs.strip()}")
rlo = versions.get("runner_last_ok")
if isinstance(rlo, str) and rlo.strip():
    print(f"rlo={rlo.strip()}")
rlf = versions.get("runner_last_fail")
if isinstance(rlf, str) and rlf.strip():
    print(f"rlf={rlf.strip()}")
rlc = versions.get("runner_last_check")
if isinstance(rlc, str) and rlc.strip():
    print(f"rlc={rlc.strip()}")
re = versions.get("runner_enabled")
if isinstance(re, bool):
    print("re=1" if re else "re=0")
asv = parsed.get("auth_status")
if isinstance(asv, str) and asv.strip():
    print(f"as={asv.strip()}")
aact = parsed.get("auth_action")
if isinstance(aact, str) and aact.strip():
    print(f"aa={aact.strip()}")
amsg = parsed.get("auth_message")
if isinstance(amsg, str) and amsg.strip():
    print(f"am={amsg.strip()}")
def _emit_int(key, prefix):
    if isinstance(key, bool):
        return
    if isinstance(key, (int, float)):
        print(f"{prefix}={int(key)}")
        return
    if isinstance(key, str):
        normalized = key.strip()
        if not normalized:
            return
        if re.fullmatch(r"-?\d+(?:\.\d+)?", normalized):
            print(f"{prefix}={int(float(normalized))}")
hv = parsed.get("host_vip")
if isinstance(hv, bool):
    print("hv=1" if hv else "hv=0")
qh = parsed.get("quota_hard_fail")
if isinstance(qh, bool):
    print("qh=1" if qh else "qh=0")
elif isinstance(qh, (int, float)):
    print(f"qh={int(qh)}")
ql = parsed.get("quota_limit_percent")
if isinstance(ql, (int, float)):
    print(f"ql={int(ql)}")
qwp = parsed.get("quota_week_partition")
_emit_int(qwp, "qwp")
csil = parsed.get("cdx_silent")
if isinstance(csil, bool):
    print("cs=1" if csil else "cs=0")
hs = parsed.get("host_secure")
if isinstance(hs, bool):
    print("hs=1" if hs else "hs=0")
hlp = parsed.get("host_lane_preference")
if isinstance(hlp, str):
    hlp = hlp.strip().lower()
    if hlp in ("normal", "spark"):
        print(f"hlp={hlp}")
cgst = parsed.get("chatgpt_status")
if isinstance(cgst, str) and cgst.strip():
    print(f"cgs={cgst.strip()}")
cgpl = parsed.get("chatgpt_plan")
if isinstance(cgpl, str) and cgpl.strip():
    print(f"cgp={cgpl.strip()}")
cgnx = parsed.get("chatgpt_next")
if isinstance(cgnx, str) and cgnx.strip():
    print(f"cgn={cgnx.strip()}")
cqal = parsed.get("chatgpt_active_quota_lane")
if isinstance(cqal, str) and cqal.strip().lower() in ("normal", "spark"):
    print(f"cqal={cqal.strip().lower()}")
cd_u = parsed.get("chatgpt_daily_used_percent") or parsed.get("chatgpt_daily_used")
_emit_int(cd_u, "cgdu")
cp_u = parsed.get("chatgpt_primary_used")
_emit_int(cp_u, "cgu")
cp_l = parsed.get("chatgpt_primary_limit")
_emit_int(cp_l, "cgl")
cp_r = parsed.get("chatgpt_primary_reset_after")
_emit_int(cp_r, "cgr")
cp_a = parsed.get("chatgpt_primary_reset_at")
if isinstance(cp_a, str) and cp_a.strip():
    print(f"cga={cp_a.strip()}")
cs_u = parsed.get("chatgpt_secondary_used")
_emit_int(cs_u, "cgsu")
cs_l = parsed.get("chatgpt_secondary_limit")
_emit_int(cs_l, "cgsl")
cs_r = parsed.get("chatgpt_secondary_reset_after")
_emit_int(cs_r, "cgsr")
cs_a = parsed.get("chatgpt_secondary_reset_at")
if isinstance(cs_a, str) and cs_a.strip():
    print(f"cgsa={cs_a.strip()}")
cnp_u = parsed.get("chatgpt_normal_primary_used")
_emit_int(cnp_u, "cgnu")
cnp_l = parsed.get("chatgpt_normal_primary_limit")
_emit_int(cnp_l, "cgnl")
cnp_r = parsed.get("chatgpt_normal_primary_reset_after")
_emit_int(cnp_r, "cgnr")
cnp_a = parsed.get("chatgpt_normal_primary_reset_at")
if isinstance(cnp_a, str) and cnp_a.strip():
    print(f"cgna={cnp_a.strip()}")
cns_u = parsed.get("chatgpt_normal_secondary_used")
_emit_int(cns_u, "cgnsu")
cns_l = parsed.get("chatgpt_normal_secondary_limit")
_emit_int(cns_l, "cgnsl")
cns_r = parsed.get("chatgpt_normal_secondary_reset_after")
_emit_int(cns_r, "cgnsr")
cns_a = parsed.get("chatgpt_normal_secondary_reset_at")
if isinstance(cns_a, str) and cns_a.strip():
    print(f"cgnsa={cns_a.strip()}")
csp_u = parsed.get("chatgpt_spark_primary_used")
_emit_int(csp_u, "cgspu")
csp_l = parsed.get("chatgpt_spark_primary_limit")
_emit_int(csp_l, "cgspl")
csp_r = parsed.get("chatgpt_spark_primary_reset_after")
_emit_int(csp_r, "cgspr")
csp_a = parsed.get("chatgpt_spark_primary_reset_at")
if isinstance(csp_a, str) and csp_a.strip():
    print(f"cgspa={csp_a.strip()}")
css_u = parsed.get("chatgpt_spark_secondary_used")
_emit_int(css_u, "cgssu")
css_l = parsed.get("chatgpt_spark_secondary_limit")
_emit_int(css_l, "cgssl")
css_r = parsed.get("chatgpt_spark_secondary_reset_after")
_emit_int(css_r, "cgssr")
css_a = parsed.get("chatgpt_spark_secondary_reset_at")
if isinstance(css_a, str) and css_a.strip():
    print(f"cgssa={css_a.strip()}")
csl = parsed.get("chatgpt_spark_limit_name")
if isinstance(csl, str) and csl.strip():
    print(f"cgsln={csl.strip()}")
cmf = parsed.get("chatgpt_spark_metered_feature")
if isinstance(cmf, str) and cmf.strip():
    print(f"cgsmf={cmf.strip()}")
api_calls = parsed.get("api_calls")
_emit_int(api_calls, "hac")
month_usage = parsed.get("token_usage_month")
if isinstance(month_usage, dict):
    def _emit_month(key, prefix):
        val = month_usage.get(key)
        _emit_int(val, prefix)
    _emit_month("total", "hmtotal")
    _emit_month("input", "hminput")
    _emit_month("output", "hmoutput")
    _emit_month("cached", "hmcached")
    _emit_month("reasoning", "hmreason")
    _emit_month("events", "hmevents")
PY
)" || true
        if [[ -n "$parsed" ]]; then
          local line
          while IFS= read -r line; do
            case "$line" in
              cv=*)
                SYNC_REMOTE_CLIENT_VERSION="${line#cv=}"
                ;;
              cvs=*)
                SYNC_REMOTE_CLIENT_VERSION_SOURCE="${line#cvs=}"
                ;;
              cvx=*)
                SYNC_REMOTE_CLIENT_VERSION_ENFORCE_EXACT="${line#cvx=}"
                ;;
              wv=*)
                SYNC_REMOTE_WRAPPER_VERSION="${line#wv=}"
                ;;
              ws=*)
                SYNC_REMOTE_WRAPPER_SHA256="${line#ws=}"
                ;;
              wu=*)
                SYNC_REMOTE_WRAPPER_URL="${line#wu=}"
                ;;
              rs=*)
                RUNNER_STATE="${line#rs=}"
                ;;
              rlo=*)
                RUNNER_LAST_OK="${line#rlo=}"
                ;;
              rlf=*)
                RUNNER_LAST_FAIL="${line#rlf=}"
                ;;
              rlc=*)
                RUNNER_LAST_CHECK="${line#rlc=}"
                ;;
              re=*)
                RUNNER_ENABLED="${line#re=}"
                ;;
              as=*)
                AUTH_STATUS="${line#as=}"
                ;;
              aa=*)
                AUTH_ACTION="${line#aa=}"
                ;;
              am=*)
                AUTH_MESSAGE="${line#am=}"
                ;;
              qh=*)
                QUOTA_HARD_FAIL="${line#qh=}"
                ;;
              hv=*)
                HOST_VIP="${line#hv=}"
                ;;
              ql=*)
                QUOTA_LIMIT_PERCENT="${line#ql=}"
                ;;
              qwp=*)
                QUOTA_WEEK_PARTITION="${line#qwp=}"
                ;;
              cs=*)
                CODEX_SILENT="${line#cs=}"
                ;;
              hs=*)
                HOST_SECURE="${line#hs=}"
                ;;
              hlp=*)
                HOST_LANE_PREFERENCE="${line#hlp=}"
                ;;
              cgs=*)
                CHATGPT_STATUS="${line#cgs=}"
                ;;
              cgp=*)
                CHATGPT_PLAN="${line#cgp=}"
                ;;
              cgn=*)
                CHATGPT_NEXT="${line#cgn=}"
                ;;
              cqal=*)
                CHATGPT_ACTIVE_LANE="${line#cqal=}"
                ;;
              cgu=*)
                CHATGPT_PRIMARY_USED="${line#cgu=}"
                ;;
              cgl=*)
                CHATGPT_PRIMARY_LIMIT="${line#cgl=}"
                ;;
              cgr=*)
                CHATGPT_PRIMARY_RESET_AFTER="${line#cgr=}"
                ;;
              cga=*)
                CHATGPT_PRIMARY_RESET_AT="${line#cga=}"
                ;;
              cgsu=*)
                CHATGPT_SECONDARY_USED="${line#cgsu=}"
                ;;
              cgsl=*)
                CHATGPT_SECONDARY_LIMIT="${line#cgsl=}"
                ;;
              cgsr=*)
                CHATGPT_SECONDARY_RESET_AFTER="${line#cgsr=}"
                ;;
              cgsa=*)
                CHATGPT_SECONDARY_RESET_AT="${line#cgsa=}"
                ;;
              cgnu=*)
                CHATGPT_NORMAL_PRIMARY_USED="${line#cgnu=}"
                ;;
              cgnl=*)
                CHATGPT_NORMAL_PRIMARY_LIMIT="${line#cgnl=}"
                ;;
              cgnr=*)
                CHATGPT_NORMAL_PRIMARY_RESET_AFTER="${line#cgnr=}"
                ;;
              cgna=*)
                CHATGPT_NORMAL_PRIMARY_RESET_AT="${line#cgna=}"
                ;;
              cgnsu=*)
                CHATGPT_NORMAL_SECONDARY_USED="${line#cgnsu=}"
                ;;
              cgnsl=*)
                CHATGPT_NORMAL_SECONDARY_LIMIT="${line#cgnsl=}"
                ;;
              cgnsr=*)
                CHATGPT_NORMAL_SECONDARY_RESET_AFTER="${line#cgnsr=}"
                ;;
              cgnsa=*)
                CHATGPT_NORMAL_SECONDARY_RESET_AT="${line#cgnsa=}"
                ;;
              cgspu=*)
                CHATGPT_SPARK_PRIMARY_USED="${line#cgspu=}"
                ;;
              cgspl=*)
                CHATGPT_SPARK_PRIMARY_LIMIT="${line#cgspl=}"
                ;;
              cgspr=*)
                CHATGPT_SPARK_PRIMARY_RESET_AFTER="${line#cgspr=}"
                ;;
              cgspa=*)
                CHATGPT_SPARK_PRIMARY_RESET_AT="${line#cgspa=}"
                ;;
              cgssu=*)
                CHATGPT_SPARK_SECONDARY_USED="${line#cgssu=}"
                ;;
              cgssl=*)
                CHATGPT_SPARK_SECONDARY_LIMIT="${line#cgssl=}"
                ;;
              cgssr=*)
                CHATGPT_SPARK_SECONDARY_RESET_AFTER="${line#cgssr=}"
                ;;
              cgssa=*)
                CHATGPT_SPARK_SECONDARY_RESET_AT="${line#cgssa=}"
                ;;
              cgsln=*)
                CHATGPT_SPARK_LIMIT_NAME="${line#cgsln=}"
                ;;
              cgsmf=*)
                CHATGPT_SPARK_METERED_FEATURE="${line#cgsmf=}"
                ;;
              cgdu=*)
                CHATGPT_DAILY_USED="${line#cgdu=}"
                ;;
              hac=*)
                HOST_API_CALLS="${line#hac=}"
                ;;
              hmtotal=*)
                HOST_TOKENS_MONTH_TOTAL="${line#hmtotal=}"
                ;;
              hminput=*)
                HOST_TOKENS_MONTH_INPUT="${line#hminput=}"
                ;;
              hmoutput=*)
                HOST_TOKENS_MONTH_OUTPUT="${line#hmoutput=}"
                ;;
              hmcached=*)
                HOST_TOKENS_MONTH_CACHED="${line#hmcached=}"
                ;;
              hmreason=*)
                HOST_TOKENS_MONTH_REASONING="${line#hmreason=}"
                ;;
              hmevents=*)
                HOST_TOKENS_MONTH_EVENTS="${line#hmevents=}"
                ;;
            esac
          done <<<"$parsed"

          if [[ -z "$CHATGPT_NORMAL_PRIMARY_USED" && -n "$CHATGPT_PRIMARY_USED" ]]; then
            CHATGPT_NORMAL_PRIMARY_USED="$CHATGPT_PRIMARY_USED"
            CHATGPT_NORMAL_PRIMARY_LIMIT="$CHATGPT_PRIMARY_LIMIT"
            CHATGPT_NORMAL_PRIMARY_RESET_AFTER="$CHATGPT_PRIMARY_RESET_AFTER"
            CHATGPT_NORMAL_PRIMARY_RESET_AT="$CHATGPT_PRIMARY_RESET_AT"
            CHATGPT_NORMAL_SECONDARY_USED="$CHATGPT_SECONDARY_USED"
            CHATGPT_NORMAL_SECONDARY_LIMIT="$CHATGPT_SECONDARY_LIMIT"
            CHATGPT_NORMAL_SECONDARY_RESET_AFTER="$CHATGPT_SECONDARY_RESET_AFTER"
            CHATGPT_NORMAL_SECONDARY_RESET_AT="$CHATGPT_SECONDARY_RESET_AT"
          fi

          if [[ "$CHATGPT_ACTIVE_LANE" != "spark" && "$CHATGPT_ACTIVE_LANE" != "normal" ]]; then
            CHATGPT_ACTIVE_LANE="normal"
          fi

          local has_spark_lane=0
          if [[ -n "$CHATGPT_SPARK_PRIMARY_USED" || -n "$CHATGPT_SPARK_PRIMARY_LIMIT" || -n "$CHATGPT_SPARK_SECONDARY_USED" || -n "$CHATGPT_SPARK_SECONDARY_LIMIT" ]]; then
            has_spark_lane=1
          fi
          if [[ "$CHATGPT_ACTIVE_LANE" == "spark" && "$has_spark_lane" != "1" ]]; then
            CHATGPT_ACTIVE_LANE="normal"
          fi

          if [[ "$CHATGPT_ACTIVE_LANE" == "spark" ]]; then
            CHATGPT_PRIMARY_USED="$CHATGPT_SPARK_PRIMARY_USED"
            CHATGPT_PRIMARY_LIMIT="$CHATGPT_SPARK_PRIMARY_LIMIT"
            CHATGPT_PRIMARY_RESET_AFTER="$CHATGPT_SPARK_PRIMARY_RESET_AFTER"
            CHATGPT_PRIMARY_RESET_AT="$CHATGPT_SPARK_PRIMARY_RESET_AT"
            CHATGPT_SECONDARY_USED="$CHATGPT_SPARK_SECONDARY_USED"
            CHATGPT_SECONDARY_LIMIT="$CHATGPT_SPARK_SECONDARY_LIMIT"
            CHATGPT_SECONDARY_RESET_AFTER="$CHATGPT_SPARK_SECONDARY_RESET_AFTER"
            CHATGPT_SECONDARY_RESET_AT="$CHATGPT_SPARK_SECONDARY_RESET_AT"
          else
            CHATGPT_PRIMARY_USED="$CHATGPT_NORMAL_PRIMARY_USED"
            CHATGPT_PRIMARY_LIMIT="$CHATGPT_NORMAL_PRIMARY_LIMIT"
            CHATGPT_PRIMARY_RESET_AFTER="$CHATGPT_NORMAL_PRIMARY_RESET_AFTER"
            CHATGPT_PRIMARY_RESET_AT="$CHATGPT_NORMAL_PRIMARY_RESET_AT"
            CHATGPT_SECONDARY_USED="$CHATGPT_NORMAL_SECONDARY_USED"
            CHATGPT_SECONDARY_LIMIT="$CHATGPT_NORMAL_SECONDARY_LIMIT"
            CHATGPT_SECONDARY_RESET_AFTER="$CHATGPT_NORMAL_SECONDARY_RESET_AFTER"
            CHATGPT_SECONDARY_RESET_AT="$CHATGPT_NORMAL_SECONDARY_RESET_AT"
          fi

          if [[ "$HOST_SECURE" == "0" || "$(lowercase "$HOST_SECURE")" == "false" ]]; then
            HOST_IS_SECURE=0
            PURGE_AUTH_AFTER_RUN=1
            emit_insecure_notice
            if [[ -z "$INSECURE_SESSION_STARTED_AT" ]]; then
              INSECURE_SESSION_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
            fi
          else
            HOST_IS_SECURE=1
            PURGE_AUTH_AFTER_RUN=0
            INSECURE_SESSION_STARTED_AT=""
          fi
        fi
      fi
      AUTH_PULL_STATUS="ok"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 0
    else
      api_status=$?
      if [[ "$api_output" == offline:* ]]; then
        offline_reason="${api_output#offline:}"
      fi
      if [[ "$api_output" == denied:* ]]; then
        deny_reason="${api_output#denied:}"
      fi
      if [[ "$api_status" == "25" ]]; then
        AUTH_PULL_STATUS="pending"
        AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
        if (( wait_logged == 0 )); then
          log_warn "Insecure host window closed; waiting for admin approval (polling every 5s)."
          wait_logged=1
        fi
        sleep 5
        continue
      fi
    fi
    break
  done
  case "$api_status" in
    10)
      log_warn "Auth sync denied: invalid API key; removing local auth.json"
      AUTH_PULL_STATUS="invalid"
      rm -f "$auth_path" 2>/dev/null || true
      return 1
      ;;
    11)
      log_warn "Auth sync denied: host disabled; removing local auth.json"
      rm -f "$auth_path" 2>/dev/null || true
      return 1
      ;;
    12)
      log_warn "Auth sync blocked for this IP (key bound elsewhere); re-register to rotate the key. Keeping local auth.json."
      return 1
      ;;
    21|22)
      log_warn "Auth sync failed: API key missing/invalid"
      return 1
      ;;
    2|3)
      local reason_suffix=""
      if [[ -n "$offline_reason" ]]; then
        AUTH_PULL_REASON="$offline_reason"
        reason_suffix="; reason=${offline_reason}"
        log_debug "auth sync offline reason: ${offline_reason}"
      fi
      if [[ -n "$phase" ]]; then
        log_warn "Auth API sync (${phase}) unreachable (base=${CODEX_SYNC_BASE_URL}, key=$(mask_key "$CODEX_SYNC_API_KEY")${reason_suffix})"
      else
        log_warn "Auth API sync unreachable (base=${CODEX_SYNC_BASE_URL}, key=$(mask_key "$CODEX_SYNC_API_KEY")${reason_suffix})"
      fi
      AUTH_PULL_STATUS="offline"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 1
      ;;
    40)
      log_warn "Auth sync blocked: API disabled by administrator"
      AUTH_PULL_STATUS="disabled"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 1
      ;;
    24)
      log_warn "Auth sync blocked: insecure host window is closed; enable it in the admin dashboard and retry."
      AUTH_PULL_STATUS="insecure"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 1
      ;;
    27)
      local reason_label="reverse DNS mismatch"
      if [[ -n "$deny_reason" && "$deny_reason" != "reverse_dns_mismatch" ]]; then
        reason_label="$deny_reason"
      fi
      log_warn "Auth sync denied: ${reason_label}; PTR must resolve to host FQDN."
      AUTH_PULL_STATUS="fail"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 1
      ;;
    26)
      log_warn "Auth sync blocked: insecure host approval denied."
      AUTH_PULL_STATUS="insecure-denied"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 1
      ;;
    *)
      if [[ -n "$phase" ]]; then
        log_warn "Auth API sync (${phase}) failed (base=${CODEX_SYNC_BASE_URL}, key=$(mask_key "$CODEX_SYNC_API_KEY"))"
      else
        log_warn "Auth API sync failed (base=${CODEX_SYNC_BASE_URL}, key=$(mask_key "$CODEX_SYNC_API_KEY"))"
      fi
      AUTH_PULL_STATUS="fail"
      AUTH_PULL_URL="$CODEX_SYNC_BASE_URL"
      return 1
      ;;
  esac
  return 1
}
