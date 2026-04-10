# ── Claude Token Usage Extraction & Reporting ─────────────────
# Extracts token usage from Claude Code session JSONL files and
# posts to the orchestrator /usage endpoint.

USAGE_PUSH_RESULT=""
USAGE_PUSH_REASON=""
USAGE_PUSH_SUMMARY=""
USAGE_PUSH_COST=""
USAGE_PUSH_COST_REASON=""
last_usage_payload=""

extract_claude_usage_from_session_jsonl() {
  local run_start_epoch="${1:-}"
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  python3 - "$run_start_epoch" <<'PY'
import json, pathlib, sys

run_start_epoch = None
if len(sys.argv) > 1 and sys.argv[1]:
    try:
        run_start_epoch = float(sys.argv[1])
    except Exception:
        pass

# Claude Code stores sessions under ~/.claude/projects/*/sessions/
# and also directly under ~/.claude/projects/ as JSONL files.
claude_root = pathlib.Path.home() / ".claude"
if not claude_root.is_dir():
    sys.exit(0)

projects_dir = claude_root / "projects"
all_jsonl = []

# Gather JSONL files from known Claude session paths.
for search_root in [projects_dir, claude_root]:
    if not search_root.is_dir():
        continue
    try:
        all_jsonl.extend(search_root.rglob("*.jsonl"))
    except Exception:
        continue

if not all_jsonl:
    sys.exit(0)

# Deduplicate by resolved path.
seen = set()
unique = []
for f in all_jsonl:
    try:
        key = f.resolve()
    except Exception:
        key = f
    if key not in seen:
        seen.add(key)
        unique.append(f)
all_jsonl = unique

# Filter by modification time if we have a run start epoch.
if run_start_epoch is not None:
    all_jsonl = [f for f in all_jsonl
                 if f.stat().st_mtime >= run_start_epoch]

if not all_jsonl:
    sys.exit(0)

all_jsonl.sort(key=lambda f: (f.stat().st_mtime, f.name), reverse=True)


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


def build_entry(total=None, input_tokens=None, output_tokens=None,
                cached_tokens=None, cache_creation=None):
    entry = {}
    for key, val in [("total", total), ("input", input_tokens),
                     ("output", output_tokens), ("cached", cached_tokens),
                     ("cache_creation", cache_creation)]:
        cleaned = clean_int(val)
        if cleaned is not None:
            entry[key] = cleaned
    if not entry:
        return None
    parts = []
    if "total" in entry:
        parts.append(f"total={entry['total']}")
    if "input" in entry:
        p = f"input={entry['input']}"
        cached_total = (entry.get("cached") or 0) + (entry.get("cache_creation") or 0)
        if cached_total > 0:
            p += f" (+ {cached_total} cached)"
        parts.append(p)
    if "output" in entry:
        parts.append(f"output={entry['output']}")
    if parts:
        entry["line"] = "Token usage: " + " ".join(parts)
    return entry


def entry_from_usage(usage: dict):
    """Build an entry from a Claude API usage dict."""
    if not isinstance(usage, dict) or "input_tokens" not in usage:
        return None
    inp = clean_int(usage.get("input_tokens"))
    out = clean_int(usage.get("output_tokens"))
    cached_read = clean_int(usage.get("cache_read_input_tokens"))
    cached_create = clean_int(usage.get("cache_creation_input_tokens"))
    tot = None
    if inp is not None or out is not None:
        tot = (inp or 0) + (out or 0)
    return build_entry(
        total=tot, input_tokens=inp, output_tokens=out,
        cached_tokens=cached_read, cache_creation=cached_create,
    )


def parse_jsonl(candidate):
    entries = []
    last_sig = None
    try:
        with candidate.open("r", encoding="utf-8", errors="ignore") as fh:
            for raw_line in fh:
                try:
                    parsed = json.loads(raw_line)
                except Exception:
                    continue

                if not isinstance(parsed, dict):
                    continue

                entry = None

                # Nested under message.usage (assistant turn entries).
                msg = parsed.get("message")
                if isinstance(msg, dict):
                    entry = entry_from_usage(msg.get("usage"))

                # Top-level usage object (API response style).
                if entry is None:
                    entry = entry_from_usage(parsed.get("usage"))

                # Result entries with flat token fields.
                if entry is None and parsed.get("type") == "result":
                    inp = clean_int(parsed.get("input_tokens"))
                    out = clean_int(parsed.get("output_tokens"))
                    if inp is not None or out is not None:
                        tot = (inp or 0) + (out or 0)
                        entry = build_entry(total=tot, input_tokens=inp, output_tokens=out)

                if not isinstance(entry, dict):
                    continue

                sig = tuple(entry.get(k) for k in
                            ("total", "input", "output", "cached", "cache_creation"))
                if sig == last_sig:
                    continue
                entries.append(entry)
                last_sig = sig
    except Exception:
        return []
    return entries


for candidate in all_jsonl:
    entries = parse_jsonl(candidate)
    if entries:
        print(json.dumps({"usages": entries}, separators=(",", ":")))
        sys.exit(0)

sys.exit(0)
PY
}

post_claude_usage_payload_once() {
  local base_url="$1"
  local payload_json="$2"
  local ca_file="${3-}"
  local payload_file=""
  local py_output=""
  local py_status=0
  payload_file="$(mktemp "${TMPDIR:-/tmp}/clx-usage-payload.XXXXXX")" || {
    printf '%s\n' "error=failed to allocate payload temp file"
    printf '%s\n' "retryable=false"
    return 1
  }
  if ! printf '%s' "$payload_json" >"$payload_file"; then
    rm -f "$payload_file"
    printf '%s\n' "error=failed to write payload temp file"
    printf '%s\n' "retryable=false"
    return 1
  fi
  py_output="$(
    CLAUDE_SYNC_API_KEY="$CLAUDE_SYNC_API_KEY" python3 - "$base_url" "$payload_file" "$ca_file" <<'PY'
import json, os, socket, sys, time, urllib.error, urllib.request

base = (sys.argv[1] or "").rstrip("/")
payload_path = sys.argv[2]
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
api_key = os.environ.get("CLAUDE_SYNC_API_KEY", "")

try:
    with open(payload_path, "r", encoding="utf-8", errors="replace") as fh:
        payload_raw = fh.read()
    payload = json.loads(payload_raw)
except Exception:
    print("error=invalid payload")
    sys.exit(1)

body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
headers = {
    "Content-Type": "application/json",
    "X-API-Key": api_key,
    "X-Engine": "claude",
}
url = f"{base}/usage"
req = urllib.request.Request(url, data=body, headers=headers, method="POST")
request_timeout = 3


def build_ssl_contexts():
    import ssl
    contexts = []
    if cafile and os.path.isfile(cafile):
        try:
            ctx = ssl.create_default_context(cafile=cafile)
            contexts.append(ctx)
        except Exception:
            pass
    contexts.append(None)
    return contexts


def format_summary(data: dict) -> str:
    def summarize(entry: dict) -> str:
        parts = []
        for key in ("total", "input", "output", "cached", "cache_creation"):
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
    for key in ("total", "input", "output", "cached", "cache_creation"):
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
    except Exception:
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
        except Exception:
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
for ctx in build_ssl_contexts():
    try:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("request timed out")
        with urllib.request.urlopen(req, timeout=max(0.1, remaining), context=ctx) as resp:
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
    except Exception as exc:
        last_err = "request timed out" if is_timeout_error(exc) else str(exc)
        last_retryable = False
        continue

if last_err:
    print(f"error={last_err}")
    print(f"retryable={'true' if last_retryable else 'false'}")
sys.exit(last_code)
PY
  )" || py_status=$?
  rm -f "$payload_file"
  printf "%s" "$py_output"
  return "$py_status"
}

post_claude_usage_payload() {
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
  USAGE_PUSH_SUMMARY="$(parse_claude_usage_summary "$payload_json")"
  USAGE_PUSH_COST=""
  USAGE_PUSH_COST_REASON=""

  if [[ -z "$payload_json" ]]; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="no usage payload"
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 0
  fi
  if [[ -z "$CLAUDE_SYNC_API_KEY" || -z "$CLAUDE_SYNC_BASE_URL" ]]; then
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

  output="$(post_claude_usage_payload_once "$CLAUDE_SYNC_BASE_URL" "$payload_json" "$CLAUDE_SYNC_CA_FILE")" || status=$?
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
  done <<<"$output"
  if [[ -n "$summary" ]]; then
    USAGE_PUSH_SUMMARY="$summary"
  fi

  if ((status == 0)); then
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

  if ((status == 40)); then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="API disabled by administrator"
    USAGE_PUSH_COST_REASON="$USAGE_PUSH_REASON"
    return 0
  fi

  local primary_err="${reason:-$output}"
  # Retry with stripped payloads for quick payload-shape failures.
  if [[ "$retryable" == "true" && "$payload_json" == *'"line"'* ]]; then
    local fallback_payload=""
    local fallback_payload_file=""
    fallback_payload_file="$(mktemp "${TMPDIR:-/tmp}/clx-usage-payload.XXXXXX")" || fallback_payload_file=""
    if [[ -n "$fallback_payload_file" ]]; then
      if ! printf '%s' "$payload_json" >"$fallback_payload_file"; then
        rm -f "$fallback_payload_file"
        fallback_payload_file=""
      fi
    fi
    if [[ -n "$fallback_payload_file" ]]; then
      fallback_payload="$(
      python3 - "$fallback_payload_file" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as fh:
        data = json.load(fh)
except Exception:
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
    fi
    rm -f "$fallback_payload_file"
    if [[ -n "$fallback_payload" && "$fallback_payload" != "$payload_json" ]]; then
      status=0
      summary=""
      cost=""
      recorded=""
      reason=""
      retryable="false"
      output="$(post_claude_usage_payload_once "$CLAUDE_SYNC_BASE_URL" "$fallback_payload" "$CLAUDE_SYNC_CA_FILE")" || status=$?
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
      done <<<"$output"
      if [[ -n "$summary" ]]; then
        USAGE_PUSH_SUMMARY="$summary"
      fi

      if ((status == 0)); then
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
      elif ((status == 40)); then
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

parse_claude_usage_summary() {
  local payload_json="$1"
  local summary=""
  local payload_file=""
  payload_file="$(mktemp "${TMPDIR:-/tmp}/clx-usage-payload.XXXXXX")" || payload_file=""
  if [[ -z "$payload_file" ]]; then
    printf "%s" ""
    return 0
  fi
  if ! printf '%s' "$payload_json" >"$payload_file"; then
    rm -f "$payload_file"
    printf "%s" ""
    return 0
  fi
  summary="$(
    python3 - "$payload_file" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "r", encoding="utf-8", errors="replace") as fh:
        data = json.load(fh)
except Exception:
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
cache_creation = entry.get("cache_creation")
if isinstance(total, int):
    parts.append(f"sent={total}")
if isinstance(inp, int):
    parts.append(f"input={inp}")
if isinstance(out, int):
    parts.append(f"output={out}")
if isinstance(cached, int):
    parts.append(f"cached={cached}")
if isinstance(cache_creation, int):
    parts.append(f"cache_creation={cache_creation}")
if isinstance(usages, list) and len(usages) > 1:
    parts.append(f"rows={len(usages)}")
if parts:
    print(", ".join(parts))
PY
  )" || summary=""
  rm -f "$payload_file"
  printf "%s" "$summary"
}

send_claude_usage_from_session_jsonl() {
  local run_start_epoch=""
  if [[ "${CLX_RUN_START_NS:-}" =~ ^[0-9]+$ ]]; then
    run_start_epoch=$((CLX_RUN_START_NS / 1000000000))
  fi
  local payload
  if ! payload="$(extract_claude_usage_from_session_jsonl "$run_start_epoch")"; then
    USAGE_PUSH_RESULT="skipped"
    USAGE_PUSH_REASON="session JSONL extraction failed"
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
  post_claude_usage_payload "$payload" || true
}
