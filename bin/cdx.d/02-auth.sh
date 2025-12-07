sync_auth_with_api() {
  local phase="$1"
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
  if (( HOST_USERS_FETCHED == 0 )); then
    record_host_user_with_api || true
  fi
  local auth_path="$HOME/.codex/auth.json"
  AUTH_PULL_REASON=""
  # Drop a malformed local auth.json so we can hydrate cleanly.
  if [[ -f "$auth_path" ]] && ! validate_auth_json_file "$auth_path"; then
    rm -f "$auth_path"
  fi
  local phase_label
  phase_label="${phase:-sync}"
  # No chatty per-step auth logging; final summary will capture the outcome.
  local api_output=""
  local api_status=0
  local offline_reason=""
  if api_output="$(CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" python3 - "$CODEX_SYNC_BASE_URL" "$auth_path" "$CODEX_SYNC_CA_FILE" "$LOCAL_VERSION" "$WRAPPER_VERSION" <<'PY'
import hashlib, json, os, pathlib, ssl, sys, urllib.error, urllib.request

base = (sys.argv[1] or "").rstrip("/")
path = pathlib.Path(sys.argv[2]).expanduser()
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
client_version = sys.argv[4] if len(sys.argv) > 4 else "unknown"
wrapper_version = sys.argv[5] if len(sys.argv) > 5 else "unknown"
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")
installation_id = (os.environ.get("CODEX_INSTALLATION_ID", "") or "").strip()

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


def build_context():
    contexts = []
    # Preferred: custom CA if provided
    ctx_primary = ssl.create_default_context()
    if cafile:
        try:
            ctx_primary.load_verify_locations(cafile)
        except Exception:
            ctx_primary = None
    if ctx_primary is not None:
        try:
            ctx_primary.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except AttributeError:
            pass
        contexts.append(ctx_primary)
    # Fallback: system default
    try:
        ctx_default = ssl.create_default_context()
        ctx_default.verify_flags &= ~ssl.VERIFY_X509_STRICT
        contexts.append(ctx_default)
    except Exception:
        pass
    # Last resort: unverified (only if others fail)
    allow_insecure = os.environ.get("CODEX_SYNC_ALLOW_INSECURE", "").lower() in ("1", "true", "yes")
    if allow_insecure:
        try:
            contexts.append(ssl._create_unverified_context())
        except Exception:
            pass
    return contexts or [None]


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
    if exc.code == 403:
        if "host is disabled" in msg_lower:
            sys.exit(11)
        if detail_code == "insecure_api_disabled" or "insecure host api access disabled" in msg_lower:
            print("insecure host API access disabled", file=sys.stderr)
            sys.exit(24)
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
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    contexts = build_context()
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
chatgpt_usage = payload_data.get("chatgpt_usage") if isinstance(payload_data, dict) else {}
host_info = payload_data.get("host") if isinstance(payload_data, dict) else {}
host_secure = normalize_bool(host_info.get("secure")) if isinstance(host_info, dict) else None


def record_versions(vblock):
    out = {}
    if isinstance(vblock, dict):
        cv = vblock.get("client_version")
        if isinstance(cv, str) and cv.strip():
            out["client_version"] = cv.strip()
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

primary_window = window(chatgpt_usage.get("primary_window"))
secondary_window = window(chatgpt_usage.get("secondary_window"))

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

if status in ("missing", "upload_required"):
    store_payload = {
        "command": "store",
        "auth": current,
        "client_version": client_version or "unknown",
    }
    if canonical_digest:
        store_payload["digest"] = canonical_digest
    if wrapper_version and wrapper_version != "unknown":
        store_payload["wrapper_version"] = wrapper_version
    if installation_id:
        store_payload["installation_id"] = installation_id
    update_data = post_json(f"{base}/auth", store_payload, "auth store")
    payload_data = update_data.get("data") if isinstance(update_data, dict) else {}
    versions_out = record_versions(payload_data.get("versions", {})) or versions_out
    host_info = payload_data.get("host") if isinstance(payload_data, dict) else host_info
    host_secure = normalize_bool(host_info.get("secure")) if isinstance(host_info, dict) else host_secure
    server_installation = versions_out.get("installation_id")
    if server_installation and installation_id and server_installation != installation_id:
        print("Installation ID mismatch; wrapper belongs to a different server", file=sys.stderr)
        sys.exit(42)
    auth_to_write = payload_data.get("auth") or current
    lr = payload_data.get("canonical_last_refresh") or payload_data.get("last_refresh")
    if isinstance(lr, str):
        auth_to_write["last_refresh"] = lr

if not isinstance(auth_to_write, dict):
    auth_to_write = current

path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(auth_to_write, indent=2) + "\n", encoding="utf-8")
try:
    os.chmod(path, 0o600)
except PermissionError:
    pass

# Surface versions and auth outcome to caller via stdout as JSON
print(
    json.dumps(
        {
            "versions": versions_out,
            "auth_status": status or "unknown",
            "auth_action": ("store" if status in ("missing", "upload_required") else status or "unknown"),
            "auth_message": (
                "synced (no change)" if status == "valid" else
                "updated from api" if status == "outdated" else
                "uploaded current auth" if status in ("missing", "upload_required") else
                status
            ),
            "host_secure": host_secure,
            "chatgpt_status": chatgpt_usage.get("status"),
            "chatgpt_plan": chatgpt_usage.get("plan_type"),
            "chatgpt_next": chatgpt_usage.get("next_eligible_at"),
            "chatgpt_primary_used": primary_window.get("used_percent"),
            "chatgpt_primary_limit": primary_window.get("limit_seconds"),
            "chatgpt_primary_reset_after": primary_window.get("reset_after_seconds"),
            "chatgpt_primary_reset_at": primary_window.get("reset_at"),
            "chatgpt_secondary_used": secondary_window.get("used_percent"),
            "chatgpt_secondary_limit": secondary_window.get("limit_seconds"),
            "chatgpt_secondary_reset_after": secondary_window.get("reset_after_seconds"),
            "chatgpt_secondary_reset_at": secondary_window.get("reset_at"),
            "api_calls": payload_data.get("api_calls"),
            "token_usage_month": payload_data.get("token_usage_month"),
            "quota_hard_fail": payload_data.get("quota_hard_fail"),
            "quota_limit_percent": payload_data.get("quota_limit_percent"),
            "cdx_silent": payload_data.get("cdx_silent"),
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
import json, os, sys
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
wv = versions.get("wrapper_version")
ws = versions.get("wrapper_sha256")
wu = versions.get("wrapper_url")
if isinstance(cv, str) and cv.strip():
    print(f"cv={cv.strip()}")
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
qh = parsed.get("quota_hard_fail")
if isinstance(qh, bool):
    print("qh=1" if qh else "qh=0")
elif isinstance(qh, (int, float)):
    print(f"qh={int(qh)}")
ql = parsed.get("quota_limit_percent")
if isinstance(ql, (int, float)):
    print(f"ql={int(ql)}")
csil = parsed.get("cdx_silent")
if isinstance(csil, bool):
    print("cs=1" if csil else "cs=0")
hs = parsed.get("host_secure")
if isinstance(hs, bool):
    print("hs=1" if hs else "hs=0")
cgst = parsed.get("chatgpt_status")
if isinstance(cgst, str) and cgst.strip():
    print(f"cgs={cgst.strip()}")
cgpl = parsed.get("chatgpt_plan")
if isinstance(cgpl, str) and cgpl.strip():
    print(f"cgp={cgpl.strip()}")
cgnx = parsed.get("chatgpt_next")
if isinstance(cgnx, str) and cgnx.strip():
    print(f"cgn={cgnx.strip()}")
def _emit_int(key, prefix):
    if isinstance(key, (int, float)):
        print(f"{prefix}={int(key)}")
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
            ql=*)
              QUOTA_LIMIT_PERCENT="${line#ql=}"
              ;;
            cs=*)
              CODEX_SILENT="${line#cs=}"
              ;;
            hs=*)
              HOST_SECURE="${line#hs=}"
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

        if [[ "$HOST_SECURE" == "0" || "${HOST_SECURE,,}" == "false" ]]; then
          HOST_IS_SECURE=0
          PURGE_AUTH_AFTER_RUN=1
          emit_insecure_notice
        else
          HOST_IS_SECURE=1
          PURGE_AUTH_AFTER_RUN=0
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
  fi
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

get_auth_last_refresh() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
 python3 - "$path" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    sys.exit(0)
if isinstance(data, dict):
    lr = data.get("last_refresh")
    if isinstance(lr, str):
        print(lr, end="")
PY
}

is_last_refresh_recent() {
  local last_refresh="$1"
  local max_age_seconds="${2:-$MAX_LOCAL_AUTH_AGE_SECONDS}"
  if [[ -z "$last_refresh" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 - "$last_refresh" "$max_age_seconds" <<'PY'
import sys, datetime
from datetime import timezone

value = sys.argv[1]
max_age_seconds = int(sys.argv[2])
max_future_skew = 300
try:
    dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.datetime.now(timezone.utc)
    delta = now - dt
except Exception:  # noqa: BLE001
    sys.exit(1)

if delta.total_seconds() < -max_future_skew:
    sys.exit(1)
if delta.total_seconds() <= max_age_seconds:
    sys.exit(0)
sys.exit(1)
PY
}

validate_auth_json_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 - "$path" <<'PY'
import json, sys, pathlib

path = pathlib.Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    sys.exit(1)

if not isinstance(data, dict):
    sys.exit(1)

last_refresh = data.get("last_refresh")
auths = data.get("auths")

if not isinstance(last_refresh, str) or not last_refresh.strip():
    sys.exit(1)

if not isinstance(auths, dict) or not auths:
    sys.exit(1)

for target, entry in auths.items():
    if not isinstance(target, str) or not target.strip():
        sys.exit(1)
    if not isinstance(entry, dict):
        sys.exit(1)
    token = entry.get("token")
    if not isinstance(token, str) or not token.strip():
        sys.exit(1)

sys.exit(0)
PY
}

push_auth_if_changed() {
  local phase="${1:-push}"
  local auth_path="$HOME/.codex/auth.json"
  local refreshed
  refreshed="$(get_auth_last_refresh "$auth_path")"
  # No local auth present
  if [[ -z "$ORIGINAL_LAST_REFRESH" && -z "$refreshed" ]]; then
    AUTH_PUSH_RESULT="skipped"
    AUTH_PUSH_REASON="no local auth.json"
    return 0
  fi
  if [[ "$refreshed" == "$ORIGINAL_LAST_REFRESH" ]]; then
    AUTH_PUSH_RESULT="not-needed"
    AUTH_PUSH_REASON="auth.json unchanged"
    return 0
  fi
  if sync_auth_with_api "$phase"; then
    SYNC_PUSH_COMPLETED=1
    AUTH_PUSH_RESULT="uploaded"
    AUTH_PUSH_REASON="auth.json changed"
    return 0
  fi
  AUTH_PUSH_RESULT="failed"
  AUTH_PUSH_REASON="api sync error"
  return 1
}
