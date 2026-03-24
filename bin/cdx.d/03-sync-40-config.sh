
sync_startup_bundle_pull() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi

  local summary status_code
  local home_path="${HOME:-}"
  set +e
  summary="$(
    startup_sync_bundle_python \
      "$CODEX_SYNC_BASE_URL" \
      "$CODEX_SYNC_API_KEY" \
      "$PROMPT_DIR" \
      "$SKILL_DIR" \
      "$AGENTS_PATH" \
      "$CONFIG_PATH" \
      "$CODEX_SYNC_CA_FILE" \
      "$PROMPT_BASELINE_FILE" \
      "$SKILL_BASELINE_FILE" \
      "$CURRENT_USER" \
      "$home_path" \
      "$LOCAL_HOSTNAME"
  )"
  status_code=$?
  set -e

  if (( status_code == 42 )); then
    return 1
  fi
  if (( status_code != 0 )); then
    return 1
  fi

  local parsed
  parsed="$(SYNC_SUMMARY="$summary" python3 - <<'PY'
import json
import os
import sys

raw = os.environ.get("SYNC_SUMMARY", "")
try:
    parsed = json.loads(raw)
except Exception:
    sys.exit(1)

if not isinstance(parsed, dict):
    sys.exit(1)

if str(parsed.get("status", "")).lower() != "ok":
    sys.exit(1)

phase = str(parsed.get("phase", "")).strip().lower() or "ok"
print(f"phase={phase}")

for key in ("prompt", "skill"):
    block = parsed.get(key)
    if not isinstance(block, dict):
        continue
    print(f"{key}_status={str(block.get('status') or 'ok').strip().lower() or 'ok'}")
    for metric in ("updated", "errors", "remote", "local", "removed"):
        val = block.get(metric)
        if isinstance(val, (int, float)):
            print(f"{key}_{metric}={int(val)}")

agents = parsed.get("agents")
if isinstance(agents, dict):
    print(f"agents_status={str(agents.get('status') or 'ok').strip().lower() or 'ok'}")
    print(f"agents_state={str(agents.get('state') or '').strip().lower()}")
    print(f"agents_sha={str(agents.get('sha256') or '').strip()}")
    print(f"agents_updated_at={str(agents.get('updated_at') or '').strip()}")
    bytes_val = agents.get("bytes")
    if isinstance(bytes_val, (int, float)):
        print(f"agents_bytes={int(bytes_val)}")
    removed_val = agents.get("removed")
    if isinstance(removed_val, (int, float)):
        print(f"agents_removed={int(removed_val)}")

config = parsed.get("config")
if isinstance(config, dict):
    print(f"config_status={str(config.get('status') or 'ok').strip().lower() or 'ok'}")
    print(f"config_state={str(config.get('state') or '').strip().lower()}")
    print(f"config_sha={str(config.get('sha256') or '').strip()}")
    print(f"config_updated_at={str(config.get('updated_at') or '').strip()}")
    bytes_val = config.get("bytes")
    if isinstance(bytes_val, (int, float)):
        print(f"config_bytes={int(bytes_val)}")
    removed_val = config.get("removed")
    if isinstance(removed_val, (int, float)):
        print(f"config_removed={int(removed_val)}")
PY
  )" || return 1

  local line
  for line in $parsed; do
    case "$line" in
      prompt_status=*) PROMPT_SYNC_STATUS="${line#prompt_status=}" ;;
      prompt_updated=*) PROMPT_PULL_UPDATED="${line#prompt_updated=}" ;;
      prompt_errors=*) PROMPT_PULL_ERRORS="${line#prompt_errors=}" ;;
      prompt_remote=*) PROMPT_REMOTE_COUNT="${line#prompt_remote=}" ;;
      prompt_local=*) PROMPT_LOCAL_COUNT="${line#prompt_local=}" ;;
      prompt_removed=*) PROMPT_REMOVED="${line#prompt_removed=}" ;;
      skill_status=*) SKILL_SYNC_STATUS="${line#skill_status=}" ;;
      skill_updated=*) SKILL_PULL_UPDATED="${line#skill_updated=}" ;;
      skill_errors=*) SKILL_PULL_ERRORS="${line#skill_errors=}" ;;
      skill_remote=*) SKILL_REMOTE_COUNT="${line#skill_remote=}" ;;
      skill_local=*) SKILL_LOCAL_COUNT="${line#skill_local=}" ;;
      skill_removed=*) SKILL_REMOVED="${line#skill_removed=}" ;;
      agents_status=*) AGENTS_SYNC_STATUS="${line#agents_status=}" ;;
      agents_state=*) AGENTS_STATE="${line#agents_state=}" ;;
      agents_sha=*) AGENTS_REMOTE_SHA="${line#agents_sha=}" ;;
      agents_updated_at=*) AGENTS_REMOTE_UPDATED_AT="${line#agents_updated_at=}" ;;
      agents_bytes=*) AGENTS_REMOTE_BYTES="${line#agents_bytes=}" ;;
      agents_removed=*) AGENTS_REMOVED="${line#agents_removed=}" ;;
      config_status=*) CONFIG_SYNC_STATUS="${line#config_status=}" ;;
      config_state=*) CONFIG_STATE="${line#config_state=}" ;;
      config_sha=*) CONFIG_REMOTE_SHA="${line#config_sha=}" ;;
      config_updated_at=*) CONFIG_REMOTE_UPDATED_AT="${line#config_updated_at=}" ;;
      config_bytes=*) CONFIG_REMOTE_BYTES="${line#config_bytes=}" ;;
      config_removed=*) CONFIG_REMOVED="${line#config_removed=}" ;;
    esac
  done

  PROMPT_SYNC_REASON=""
  SKILL_SYNC_REASON=""
  AGENTS_SYNC_REASON=""
  CONFIG_SYNC_REASON=""
  [[ -z "$PROMPT_SYNC_STATUS" ]] && PROMPT_SYNC_STATUS="ok"
  [[ -z "$SKILL_SYNC_STATUS" ]] && SKILL_SYNC_STATUS="ok"
  [[ -z "$AGENTS_SYNC_STATUS" ]] && AGENTS_SYNC_STATUS="ok"
  [[ -z "$CONFIG_SYNC_STATUS" ]] && CONFIG_SYNC_STATUS="ok"
  return 0
}

sync_config_pull() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    CONFIG_SYNC_STATUS="missing-config"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    CONFIG_SYNC_STATUS="no-python"
    if (( SYNC_WARNED_NO_PYTHON == 0 )); then
      log_warn "python3 is required for config.toml sync; skipping."
      SYNC_WARNED_NO_PYTHON=1
    fi
    return 1
  fi
  local current_sha=""
  if [[ -f "$CONFIG_PATH" ]]; then
    current_sha="$(python3 - "$CONFIG_PATH" <<'PY'
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
  summary="$(config_sync_python "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_API_KEY" "$CONFIG_PATH" "$CODEX_SYNC_CA_FILE" "$current_sha")"
  status_code=$?
  set -e
  CONFIG_SYNC_STATUS="error"
  CONFIG_STATE=""
  CONFIG_REMOTE_SHA=""
  CONFIG_REMOTE_UPDATED_AT=""
  CONFIG_REMOTE_BYTES=""
  CONFIG_REMOVED=0
  if (( status_code != 0 )); then
    local reason=""
    if [[ "$summary" == error\ reason=* ]]; then
      reason="${summary#error reason=}"
    fi
    if [[ "$reason" == http-5* ]] || [[ "$reason" == request_failed* ]]; then
      CONFIG_SYNC_STATUS="offline"
      CONFIG_SYNC_REASON="$reason"
    else
      CONFIG_SYNC_STATUS="error"
      CONFIG_SYNC_REASON="$reason"
    fi
    return 1
  fi
  CONFIG_SYNC_STATUS="${summary%% *}"
  CONFIG_SYNC_REASON=""
  local part
  for part in $summary; do
    case "$part" in
      status=*) CONFIG_STATE="${part#status=}" ;;
      sha256=*) CONFIG_REMOTE_SHA="${part#sha256=}" ;;
      updated_at=*) CONFIG_REMOTE_UPDATED_AT="${part#updated_at=}" ;;
      bytes=*) CONFIG_REMOTE_BYTES="${part#bytes=}" ;;
      removed=*) CONFIG_REMOVED="${part#removed=}" ;;
    esac
  done
  return 0
}

otel_env_from_config_python() {
  python3 - "$CONFIG_PATH" <<'PY'
import os, re, sys

path = sys.argv[1]
try:
    raw = open(path, "r", encoding="utf-8", errors="ignore").read()
except Exception:
    sys.exit(0)

def find_block(name: str) -> str:
    # Allow an optional inline TOML comment after the closing bracket,
    # e.g. `[otel] # my settings` is valid TOML and must still be matched.
    m = re.search(r'(?m)^\[' + re.escape(name) + r'\]\s*(?:#.*)?$', raw)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r'(?m)^\[', raw[start:])
    end = start + (m2.start() if m2 else len(raw[start:]))
    return raw[start:end]

block = find_block("otel")
if not block.strip():
    sys.exit(0)

def parse_value(v: str):
    v = v.strip()
    if v.startswith('"') and v.endswith('"'):
        return v[1:-1]
    if v.lower() in ("true", "false"):
        return v.lower()
    return v

def parse_inline_table(v: str):
    # Very small TOML-ish parser for { k = "v", ... } used by our builder.
    v = v.strip()
    if not (v.startswith("{") and v.endswith("}")):
        return {}
    inner = v[1:-1].strip()
    if not inner:
        return {}
    parts = []
    buf = ""
    in_str = False
    esc = False
    for ch in inner:
        if esc:
            buf += ch
            esc = False
            continue
        if ch == "\\":
            buf += ch
            esc = True
            continue
        if ch == '"':
            in_str = not in_str
            buf += ch
            continue
        if ch == "," and not in_str:
            parts.append(buf)
            buf = ""
        else:
            buf += ch
    if buf.strip():
        parts.append(buf)
    out = {}
    for part in parts:
        if "=" not in part:
            continue
        k, val = part.split("=", 1)
        k = k.strip()
        out[k] = parse_value(val)
    return out

otel = {}
for line in block.splitlines():
    line = line.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    k, v = line.split("=", 1)
    k = k.strip()
    otel[k] = v.strip()

exporter = parse_value(otel.get("exporter", "")).strip()
environment = parse_value(otel.get("environment", "")).strip()
log_prompts = parse_value(otel.get("log_user_prompt", "")).strip()

if exporter in ("", "none"):
    sys.exit(0)

endpoint = parse_value(otel.get("endpoint", "")).strip()
protocol = parse_value(otel.get("protocol", "")).strip()
headers = parse_inline_table(otel.get("headers", "{}"))

def emit(k: str, v: str):
    if v is None:
        return
    v = str(v).strip()
    if v == "":
        return
    print(f"{k}={v}")

# Emit env vars as k=v lines; shell will export them.
emit("OTEL_SERVICE_NAME", "cdx")
if environment:
    emit("OTEL_RESOURCE_ATTRIBUTES", f"deployment.environment={environment}")

if exporter == "otlp-http":
    emit("OTEL_TRACES_EXPORTER", "otlp")
    emit("OTEL_EXPORTER_OTLP_PROTOCOL", protocol or "http/protobuf")
    if endpoint:
        emit("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)
elif exporter == "otlp-grpc":
    emit("OTEL_TRACES_EXPORTER", "otlp")
    emit("OTEL_EXPORTER_OTLP_PROTOCOL", "grpc")
    if endpoint:
        emit("OTEL_EXPORTER_OTLP_ENDPOINT", endpoint)

if headers:
    # OTEL expects comma-separated key=value
    header_str = ",".join([f"{k}={v}" for k, v in headers.items() if str(k).strip() and str(v).strip()])
    emit("OTEL_EXPORTER_OTLP_HEADERS", header_str)

# Optional: prompt logging toggle. We expose as CODEX wrapper env, not OpenTelemetry standard.
if log_prompts in ("true", "false"):
    emit("CODEX_OTEL_LOG_USER_PROMPT", log_prompts)
PY
}
