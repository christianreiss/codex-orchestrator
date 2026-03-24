
push_slash_commands_if_changed() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    PROMPT_PUSH_STATUS="missing-config"
    return 0
  fi
  if [[ ! -f "$PROMPT_BASELINE_FILE" ]]; then
    PROMPT_PUSH_STATUS="no-baseline"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    PROMPT_PUSH_STATUS="no-python"
    return 0
  fi
  local summary status_code
  set +e
  summary="$(prompt_sync_python push "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_API_KEY" "$PROMPT_DIR" "$CODEX_SYNC_CA_FILE" "$PROMPT_BASELINE_FILE")"
  status_code=$?
  set -e
  PROMPT_PUSH_STATUS="error"
  if (( status_code != 0 )); then
    [[ -n "$summary" ]] && log_warn "Slash command push failed: $summary" || log_warn "Slash command push failed."
    PROMPT_PUSH_ERRORS=1
    return 1
  fi
  local part
  PROMPT_PUSH_STATUS="${summary%% *}"
  for part in $summary; do
    case "$part" in
      pushed=*) PROMPT_PUSHED="${part#pushed=}" ;;
      errors=*) PROMPT_PUSH_ERRORS="${part#errors=}" ;;
      changes=*) PROMPT_LOCAL_CHANGED="${part#changes=}" ;;
      local=*) PROMPT_LOCAL_COUNT="${part#local=}" ;;
    esac
  done
  return 0
}

push_skills_if_changed() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    SKILL_PUSH_STATUS="missing-config"
    return 0
  fi
  if [[ ! -f "$SKILL_BASELINE_FILE" ]]; then
    SKILL_PUSH_STATUS="no-baseline"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    SKILL_PUSH_STATUS="no-python"
    return 0
  fi
  local summary status_code
  set +e
  summary="$(skill_sync_python push "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_API_KEY" "$SKILL_DIR" "$CODEX_SYNC_CA_FILE" "$SKILL_BASELINE_FILE")"
  status_code=$?
  set -e
  SKILL_PUSH_STATUS="error"
  if (( status_code != 0 )); then
    [[ -n "$summary" ]] && log_warn "Skill push failed: $summary" || log_warn "Skill push failed."
    SKILL_PUSH_ERRORS=1
    return 1
  fi
  local part
  SKILL_PUSH_STATUS="${summary%% *}"
  for part in $summary; do
    case "$part" in
      pushed=*) SKILL_PUSHED="${part#pushed=}" ;;
      errors=*) SKILL_PUSH_ERRORS="${part#errors=}" ;;
      changes=*) SKILL_LOCAL_CHANGED="${part#changes=}" ;;
      local=*) SKILL_LOCAL_COUNT="${part#local=}" ;;
    esac
  done
  return 0
}

extract_token_usage_payload() {
  local log_path="$1"
  if [[ ! -f "$log_path" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  python3 - "$log_path" <<'PY'
import json, pathlib, re, sys

path = pathlib.Path(sys.argv[1])
TAIL_READ_BYTES = 262144

ansi_csi = re.compile(r"\x1B\[[0-9;?]*[ -/]*[@-~]")
ansi_osc = re.compile(r"\x1B\][^\a\x1b]*[\a\x1b\\]")
control = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
pattern = re.compile(
    r"Token usage:\s*total=(?P<total>[\d,]+)\s+input=(?P<input>[\d,]+)(?:\s*\(\+\s*(?P<cached>[\d,]+)\s*cached\))?\s+output=(?P<output>[\d,]+)(?:\s*\(reasoning\s*(?P<reasoning>[\d,]+)\))?",
    re.IGNORECASE,
)
kv_pattern = re.compile(r"\b(total|input|output|cached|reasoning)\s*[:=]\s*([\d,][\d,]*)", re.IGNORECASE)
tokens_used_pattern = re.compile(r"tokens?\s+used(?:\s*[:=]\s*(?P<total>[\d,]+))?$", re.IGNORECASE)
plain_total_pattern = re.compile(r"^(?:total\s*[:=]\s*)?(?P<total>[\d,]+)$", re.IGNORECASE)


def strip_noise(text: str) -> str:
    text = ansi_osc.sub("", text)
    text = ansi_csi.sub("", text)
    text = control.sub("", text)
    return text

def clean_int(val):
    if val is None or isinstance(val, bool):
        return None
    if isinstance(val, int):
        return val if val >= 0 else None
    if isinstance(val, float):
        return int(val) if val >= 0 else None
    try:
        return int(str(val).replace(",", ""))
    except Exception:
        return None


def safe_line(raw: str) -> str:
    line = raw.strip()
    if len(line) > 240:
        line = line[:240] + "…"
    return line


def format_usage_line(entry: dict) -> str:
    parts = []
    total = entry.get("total")
    if isinstance(total, int):
        parts.append(f"total={total}")

    input_tokens = entry.get("input")
    cached_tokens = entry.get("cached")
    if isinstance(input_tokens, int):
        input_part = f"input={input_tokens}"
        if isinstance(cached_tokens, int):
            input_part += f" (+ {cached_tokens} cached)"
        parts.append(input_part)

    output_tokens = entry.get("output")
    reasoning_tokens = entry.get("reasoning")
    if isinstance(output_tokens, int):
        output_part = f"output={output_tokens}"
        if isinstance(reasoning_tokens, int):
            output_part += f" (reasoning {reasoning_tokens})"
        parts.append(output_part)
    elif isinstance(reasoning_tokens, int):
        parts.append(f"reasoning={reasoning_tokens}")

    if not parts:
        return ""
    return "Token usage: " + " ".join(parts)


def build_entry(total=None, input_tokens=None, output_tokens=None, cached_tokens=None, reasoning_tokens=None, line=None):
    entry = {}

    total_val = clean_int(total)
    if total_val is not None:
        entry["total"] = total_val

    input_val = clean_int(input_tokens)
    if input_val is not None:
        entry["input"] = input_val

    output_val = clean_int(output_tokens)
    if output_val is not None:
        entry["output"] = output_val

    cached_val = clean_int(cached_tokens)
    if cached_val is not None:
        entry["cached"] = cached_val

    reasoning_val = clean_int(reasoning_tokens)
    if reasoning_val is not None:
        entry["reasoning"] = reasoning_val

    line_text = safe_line(line) if isinstance(line, str) and line.strip() else format_usage_line(entry)
    if line_text:
        entry["line"] = safe_line(line_text)

    if not entry:
        return None
    return entry


def build_entry_from_usage_line(raw: str):
    entry = {}
    match = pattern.search(raw)
    if match:
        entry["total"] = clean_int(match.group("total"))
        entry["input"] = clean_int(match.group("input"))
        entry["output"] = clean_int(match.group("output"))
        cached_val = clean_int(match.group("cached"))
        if cached_val is not None:
            entry["cached"] = cached_val
        reasoning_val = clean_int(match.group("reasoning"))
        if reasoning_val is not None:
            entry["reasoning"] = reasoning_val
    else:
        for key, value in kv_pattern.findall(raw):
            cleaned_val = clean_int(value)
            if cleaned_val is not None:
                entry[key.lower()] = cleaned_val
        cached_match = re.search(r"\(\+\s*([\d,]+)\s*cached", raw, re.IGNORECASE)
        if cached_match:
            cached_val = clean_int(cached_match.group(1))
            if cached_val is not None:
                entry["cached"] = cached_val

    safe_raw = safe_line(raw)
    if safe_raw:
        entry["line"] = safe_raw

    if not entry:
        return None
    return entry


def extract_tail_usage_entry(log_path: pathlib.Path):
    try:
        size = log_path.stat().st_size
        with log_path.open("rb") as handle:
            if size > TAIL_READ_BYTES:
                handle.seek(-TAIL_READ_BYTES, 2)
            tail = handle.read()
    except Exception:
        return None

    cleaned_tail = strip_noise(tail.decode("utf-8", errors="ignore"))
    for raw in reversed(cleaned_tail.splitlines()):
        line = raw.strip()
        if "token usage" not in line.lower():
            continue
        entry = build_entry_from_usage_line(line)
        if not isinstance(entry, dict):
            continue
        for key in ("total", "input", "output", "cached", "reasoning"):
            if isinstance(entry.get(key), int):
                return [entry]
    return None


def extract_session_entries(text: str):
    session_match = re.search(
        r"session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
        text,
        re.IGNORECASE,
    )
    if not session_match:
        return []

    sessions_root = pathlib.Path.home() / ".codex" / "sessions"
    if not sessions_root.is_dir():
        return []

    session_id = session_match.group(1)
    try:
        candidates = sorted(
            sessions_root.rglob(f"*{session_id}*.jsonl"),
            key=lambda candidate: candidate.stat().st_mtime,
            reverse=True,
        )
    except Exception:
        candidates = []

    for candidate in candidates:
        entries = []
        last_signature = None
        try:
            with candidate.open("r", encoding="utf-8", errors="ignore") as handle:
                for raw_line in handle:
                    try:
                        parsed = json.loads(raw_line)
                    except Exception:
                        continue

                    entry = None
                    if parsed.get("type") == "event_msg":
                        payload = parsed.get("payload")
                        if isinstance(payload, dict) and payload.get("type") == "token_count":
                            info = payload.get("info")
                            if isinstance(info, dict):
                                usage = info.get("last_token_usage")
                                if not isinstance(usage, dict):
                                    usage = info.get("total_token_usage")
                                if isinstance(usage, dict):
                                    entry = build_entry(
                                        total=usage.get("total_tokens"),
                                        input_tokens=usage.get("input_tokens"),
                                        output_tokens=usage.get("output_tokens"),
                                        cached_tokens=usage.get("cached_input_tokens"),
                                        reasoning_tokens=usage.get("reasoning_output_tokens"),
                                    )
                    elif parsed.get("type") == "turn.completed":
                        usage = parsed.get("usage")
                        if isinstance(usage, dict):
                            input_tokens = clean_int(usage.get("input_tokens"))
                            output_tokens = clean_int(usage.get("output_tokens"))
                            total_tokens = None
                            if input_tokens is not None or output_tokens is not None:
                                total_tokens = (input_tokens or 0) + (output_tokens or 0)
                            entry = build_entry(
                                total=total_tokens,
                                input_tokens=input_tokens,
                                output_tokens=output_tokens,
                                cached_tokens=usage.get("cached_input_tokens"),
                                reasoning_tokens=usage.get("reasoning_output_tokens"),
                            )

                    if not isinstance(entry, dict):
                        continue

                    signature = tuple(entry.get(key) for key in ("total", "input", "output", "cached", "reasoning"))
                    if signature == last_signature:
                        continue

                    entries.append(entry)
                    last_signature = signature
        except Exception:
            continue

        if entries:
            return entries

    return []


entries = extract_tail_usage_entry(path)
if entries:
    print(json.dumps({"usages": entries}, separators=(",", ":")))
    sys.exit(0)

try:
    content = path.read_text(encoding="utf-8", errors="ignore")
except Exception:  # noqa: BLE001
    sys.exit(0)

cleaned = strip_noise(content)
entries = extract_session_entries(cleaned)

if not entries:
    lines = [ln.strip() for ln in cleaned.splitlines() if "token usage" in ln.lower()]
    for raw in lines:
        entry = build_entry_from_usage_line(raw)
        if entry:
            entries.append(entry)

if not entries:
    raw_lines = [ln.strip() for ln in cleaned.splitlines()]
    i = 0
    while i < len(raw_lines):
        line = raw_lines[i].strip()
        if not line:
            i += 1
            continue

        tokens_used_match = tokens_used_pattern.match(line)
        if not tokens_used_match:
            i += 1
            continue

        total_text = tokens_used_match.group("total")
        if total_text is None:
            next_idx = i + 1
            while next_idx < len(raw_lines):
                next_line = raw_lines[next_idx].strip()
                if next_line:
                    break
                next_idx += 1
            else:
                next_line = ""

            plain_total_match = plain_total_pattern.match(next_line) if next_line else None
            if plain_total_match:
                total_text = plain_total_match.group("total")
                i = next_idx

        total_val = clean_int(total_text)
        if total_val is not None:
            entry = build_entry(total=total_val, line=f"tokens used {total_text}")
            if entry is not None:
                entries.append(entry)

        i += 1

if not entries:
    sys.exit(0)

print(json.dumps({"usages": entries}, separators=(",", ":")))
PY
}

post_token_usage_payload_once() {
  local base_url="$1"
  local payload_json="$2"
  local ca_file="${3-}"
  CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$base_url" "$payload_json" "$ca_file" <<'PY'
import json, os, socket, sys, time, urllib.error, urllib.request

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

base = (sys.argv[1] or "").rstrip("/")
payload_raw = sys.argv[2]
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")

try:
    payload = json.loads(payload_raw)
except Exception:  # noqa: BLE001
    print("error=invalid payload")
    sys.exit(1)

body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
headers = {"Content-Type": "application/json", "X-API-Key": api_key}
url = f"{base}/usage"
req = urllib.request.Request(url, data=body, headers=headers, method="POST")
request_timeout = 3


def build_contexts():
    if "cdx_build_ssl_contexts" in globals():
        return cdx_build_ssl_contexts(cafile)
    return [None]


def format_summary(data: dict) -> str:
    def summarize(entry: dict) -> str:
        parts = []
        for key in ("total", "input", "output", "cached", "reasoning"):
            if isinstance(entry.get(key), int):
                parts.append(f"{key}={entry[key]}")
        if not parts and entry.get("line"):
            return entry["line"]
        return " ".join(parts)

    usages = data.get("usages")
    if isinstance(usages, list) and usages:
        latest = usages[-1] if isinstance(usages[-1], dict) else {}
        summary = summarize(latest if isinstance(latest, dict) else {})
        if len(usages) > 1:
            return f"{len(usages)} rows" + (f" | {summary}" if summary else "")
        return summary

    parts = []
    for key in ("total", "input", "output", "cached", "reasoning"):
        if key in data and data[key] is not None:
            parts.append(f"{key}={data[key]}")
    if not parts and data.get("line"):
        return data["line"]
    return " ".join(parts)


def parse_response_fields(body_text: str):
    cost_value = ""
    recorded_value = ""
    reason_value = ""
    try:
        parsed = json.loads(body_text)
    except Exception:  # noqa: BLE001
        return cost_value, recorded_value, reason_value

    if not isinstance(parsed, dict):
        return cost_value, recorded_value, reason_value
    data = parsed.get("data")
    if not isinstance(data, dict):
        return cost_value, recorded_value, reason_value

    recorded = data.get("recorded")
    if isinstance(recorded, bool):
        recorded_value = "true" if recorded else "false"
    elif isinstance(recorded, (int, float)):
        recorded_value = "true" if recorded > 0 else "false"

    reason = data.get("reason")
    if isinstance(reason, str) and reason.strip():
        reason_value = reason.strip()

    cost = data.get("cost")
    if isinstance(cost, (int, float)):
        cost_value = f"{float(cost):.6f}"
    elif isinstance(cost, str):
        try:
            cost_value = f"{float(cost.strip()):.6f}"
        except Exception:  # noqa: BLE001
            cost_value = ""

    return cost_value, recorded_value, reason_value


def is_timeout_error(exc: Exception) -> bool:
    if isinstance(exc, (TimeoutError, socket.timeout)):
        return True
    reason = getattr(exc, "reason", None)
    if isinstance(reason, (TimeoutError, socket.timeout)):
        return True
    return "timed out" in str(exc).lower()


last_err = None
last_code = 1
last_retryable = False
deadline = time.monotonic() + request_timeout
for ctx in build_contexts():
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request timed out")
        with urllib.request.urlopen(req, timeout=max(0.1, remaining), context=ctx) as resp:  # noqa: S310
            body_text = resp.read(65536).decode("utf-8", "replace")
            cost_val, recorded_val, reason_val = parse_response_fields(body_text)
            print(f"summary={format_summary(payload)}")
            if cost_val:
                print(f"cost={cost_val}")
            if recorded_val:
                print(f"recorded={recorded_val}")
            if reason_val:
                print(f"reason={reason_val}")
            sys.exit(0)
    except urllib.error.HTTPError as exc:
        body_text = ""
        try:
            body_text = exc.read().decode("utf-8", "replace")
        except Exception:
            body_text = ""
        if exc.code == 503 and "disabled" in body_text.lower():
            print("reason=API disabled by administrator")
            sys.exit(40)
        body_snip = (body_text or "").replace("\n", " ").strip()
        if len(body_snip) > 160:
            body_snip = body_snip[:160] + "..."
        last_err = f"HTTP {exc.code}" + (f": {body_snip}" if body_snip else "")
        last_code = exc.code or 1
        last_retryable = True
        continue
    except Exception as exc:  # noqa: BLE001
        last_err = "request timed out" if is_timeout_error(exc) else str(exc)
        last_retryable = False
        continue

if last_err:
    print(f"error={last_err}")
    print(f"retryable={'true' if last_retryable else 'false'}")
sys.exit(last_code)
PY
}

post_token_usage_payload() {
  local payload_json="$1"
  local status=0
  local output=""
  local line=""
  local summary=""
  local cost=""
  local recorded=""
  local reason=""
  local retryable="false"

  USAGE_PUSH_RESULT=""
  USAGE_PUSH_REASON=""
  USAGE_PUSH_SUMMARY="$(parse_usage_summary "$payload_json")"
  USAGE_PUSH_COST=""
  USAGE_PUSH_COST_REASON=""

  if [[ -z "$payload_json" ]]; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="no usage payload"
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 0
  fi
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="API key or base URL missing"
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="python3 missing"
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 1
  fi

  output="$(post_token_usage_payload_once "$CODEX_SYNC_BASE_URL" "$payload_json" "$CODEX_SYNC_CA_FILE")" || status=$?
  while IFS= read -r line; do
    case "$line" in
      summary=*) summary="${line#summary=}" ;;
      cost=*) cost="${line#cost=}" ;;
      recorded=*) recorded="${line#recorded=}" ;;
      reason=*) reason="${line#reason=}" ;;
      retryable=*) retryable="${line#retryable=}" ;;
      error=*)
        if [[ -z "$reason" ]]; then
          reason="${line#error=}"
        fi
        ;;
    esac
  done <<< "$output"
  if [[ -n "$summary" ]]; then
    USAGE_PUSH_SUMMARY="$summary"
  fi

  if (( status == 0 )); then
    if [[ "$recorded" == "false" ]]; then
      USAGE_PUSH_RESULT="failed"
      USAGE_PUSH_REASON="${reason:-usage ingestion failed}"
      USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
      return 1
    fi
    USAGE_PUSH_RESULT="ok"
    USAGE_PUSH_REASON="recorded"
    if [[ -n "$cost" ]]; then
      USAGE_PUSH_COST="$cost"
    else
      USAGE_PUSH_COST_REASON="server did not return cost"
    fi
    return 0
  fi

  if (( status == 40 )); then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="API disabled by administrator"
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 0
  fi

  local primary_err="${reason:-$output}"
  # Best effort only: retry stripped payloads for quick payload-shape failures, not slow/wedged network paths.
  if [[ "$retryable" == "true" && "$payload_json" == *'"line"'* ]]; then
    local fallback_payload=""
    fallback_payload="$(python3 - "$payload_json" <<'PY'
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:  # noqa: BLE001
    sys.exit(1)
if "line" in data:
    data.pop("line", None)
usages = data.get("usages")
if isinstance(usages, list):
    cleaned = []
    for entry in usages:
        if isinstance(entry, dict):
            entry.pop("line", None)
            if entry:
                cleaned.append(entry)
    data["usages"] = cleaned
print(json.dumps(data, separators=(",", ":")))
PY
    )" || fallback_payload=""
    if [[ -n "$fallback_payload" && "$fallback_payload" != "$payload_json" ]]; then
      status=0
      summary=""
      cost=""
      recorded=""
      reason=""
      retryable="false"
      output="$(post_token_usage_payload_once "$CODEX_SYNC_BASE_URL" "$fallback_payload" "$CODEX_SYNC_CA_FILE")" || status=$?
      while IFS= read -r line; do
        case "$line" in
          summary=*) summary="${line#summary=}" ;;
          cost=*) cost="${line#cost=}" ;;
          recorded=*) recorded="${line#recorded=}" ;;
          reason=*) reason="${line#reason=}" ;;
          retryable=*) retryable="${line#retryable=}" ;;
          error=*)
            if [[ -z "$reason" ]]; then
              reason="${line#error=}"
            fi
            ;;
        esac
      done <<< "$output"
      if [[ -n "$summary" ]]; then
        USAGE_PUSH_SUMMARY="$summary"
      fi

      if (( status == 0 )); then
        if [[ "$recorded" == "false" ]]; then
          USAGE_PUSH_RESULT="failed"
          USAGE_PUSH_REASON="${reason:-usage ingestion failed}"
          USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
          return 1
        fi
        USAGE_PUSH_RESULT="ok"
        USAGE_PUSH_REASON="recorded (fallback)"
        if [[ -n "$cost" ]]; then
          USAGE_PUSH_COST="$cost"
        else
          USAGE_PUSH_COST_REASON="server did not return cost"
        fi
        return 0
      elif (( status == 40 )); then
        USAGE_PUSH_RESULT="skipped"
        USAGE_PUSH_REASON="API disabled by administrator"
        USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
        return 0
      fi
      [[ -z "$primary_err" ]] && primary_err="${reason:-$output}"
    fi
  fi

  if [[ -z "$primary_err" ]]; then
    primary_err="unknown error"
  fi
  USAGE_PUSH_RESULT="failed"
  USAGE_PUSH_REASON="$primary_err"
  USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
  return 1
}

parse_usage_summary() {
  local payload_json="$1"
  local summary=""
  summary="$(python3 - "$payload_json" <<'PY'
import json, sys
try:
    data = json.loads(sys.argv[1])
except Exception:  # noqa: BLE001
    sys.exit(0)

usages = data.get("usages")
entry = {}
if isinstance(usages, list) and usages:
    last = usages[-1]
    if isinstance(last, dict):
        entry = last
else:
    entry = data if isinstance(data, dict) else {}

parts = []
total = entry.get("total")
inp = entry.get("input")
out = entry.get("output")
cached = entry.get("cached")
reasoning = entry.get("reasoning")
if isinstance(total, int):
    parts.append(f"sent={total}")
if isinstance(inp, int):
    parts.append(f"input={inp}")
if isinstance(out, int):
    parts.append(f"output={out}")
if isinstance(cached, int):
    parts.append(f"cached={cached}")
if isinstance(reasoning, int):
    parts.append(f"reasoning={reasoning}")
if isinstance(usages, list) and len(usages) > 1:
    parts.append(f"rows={len(usages)}")
if parts:
    print(", ".join(parts))
PY
  )" || summary=""
  printf "%s" "$summary"
}

send_token_usage_if_present() {
  local log_path="$1"
  local payload
  if ! payload="$(extract_token_usage_payload "$log_path")"; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="usage extraction failed"
    USAGE_PUSH_SUMMARY=""
    USAGE_PUSH_COST=""
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 0
  fi
  if [[ -z "$payload" ]]; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="no token usage captured"
    USAGE_PUSH_SUMMARY=""
    USAGE_PUSH_COST=""
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 0
  fi

  last_usage_payload="$payload"
  post_token_usage_payload "$payload" || true
}
