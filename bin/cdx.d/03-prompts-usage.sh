
prompt_sync_python() {
  local mode="$1"
  local base="$2"
  local api_key="$3"
  local prompt_dir="$4"
  local cafile="$5"
  local baseline_file="$6"
  CODEX_SYNC_API_KEY="$api_key" python3 - "$mode" "$base" "$prompt_dir" "$cafile" "$baseline_file" <<'PY'
import hashlib, json, os, pathlib, ssl, sys, urllib.error, urllib.request

mode = sys.argv[1] if len(sys.argv) > 1 else ""
base = (sys.argv[2] or "").rstrip("/")
prompt_dir = pathlib.Path(sys.argv[3]).expanduser()
cafile = sys.argv[4] if len(sys.argv) > 4 else ""
baseline_file = pathlib.Path(sys.argv[5]).expanduser() if len(sys.argv) > 5 else prompt_dir.parent / ".prompt-baseline.json"
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")


def contexts():
    ctxs = []
    primary = ssl.create_default_context()
    if cafile:
        try:
            primary.load_verify_locations(cafile)
        except Exception:
            primary = None
    if primary is not None:
        try:
            primary.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except AttributeError:
            pass
        ctxs.append(primary)
    try:
        fallback = ssl.create_default_context()
        fallback.verify_flags &= ~ssl.VERIFY_X509_STRICT
        ctxs.append(fallback)
    except Exception:
        pass
    allow_insecure = os.environ.get("CODEX_SYNC_ALLOW_INSECURE", "").lower() in ("1", "true", "yes")
    if allow_insecure:
        try:
            ctxs.append(ssl._create_unverified_context())
        except Exception:
            pass
    return ctxs or [None]


def request_json(method: str, url: str, payload=None):
    data = None
    headers = {"X-API-Key": api_key}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last_err = None
    for ctx in contexts():
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:  # noqa: PERF203
            body = exc.read().decode("utf-8", "ignore")
            reason = f"http-{exc.code}"
            if body:
                reason = f"{reason}:{body.strip()[:80]}"
            raise RuntimeError(reason) from exc
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    raise RuntimeError(f"request failed: {last_err}")


def parse_front_matter(text: str):
    description = None
    argument_hint = None
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return description, argument_hint
    end_idx = None
    for idx in range(1, len(lines)):
        if lines[idx].strip() == "---":
            end_idx = idx
            break
    if end_idx is None:
        return description, argument_hint
    for idx in range(1, end_idx):
        line = lines[idx].strip()
        if not line or ":" not in line:
            continue
        key, value = line.split(":", 1)
        key = key.strip().lower()
        value = value.strip()
        if key == "description":
            description = value
        elif key == "argument-hint":
            argument_hint = value
    return description, argument_hint


def load_local(include_content: bool = False):
    prompt_dir.mkdir(parents=True, exist_ok=True)
    prompts = {}
    for path in prompt_dir.iterdir():
        if not path.is_file():
            continue
        try:
            content = path.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            continue
        sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        entry = {"filename": path.name, "sha": sha}
        if include_content:
            entry["content"] = content
        prompts[path.name] = entry
    return prompts


def save_baseline(prompts: dict):
    try:
        baseline_file.parent.mkdir(parents=True, exist_ok=True)
        baseline_file.write_text(json.dumps(prompts, indent=2) + "\n", encoding="utf-8")
    except Exception:  # noqa: BLE001
        pass


if not base:
    print("error reason=missing-base")
    sys.exit(1)
if not api_key:
    print("error reason=missing-api-key")
    sys.exit(1)

prompt_dir.mkdir(parents=True, exist_ok=True)

if mode == "pull":
    try:
        list_resp = request_json("GET", f"{base}/slash-commands")
    except Exception as exc:  # noqa: BLE001
        print(f"error reason={str(exc).replace(' ', '_')}")
        sys.exit(1)

    commands = []
    if isinstance(list_resp, dict):
        data = list_resp.get("data") or {}
        commands = data.get("commands") or []
    downloaded = 0
    errors = 0
    removed = 0
    local = load_local()

    for cmd in commands:
        if not isinstance(cmd, dict):
            continue
        fname = cmd.get("filename")
        rsha = cmd.get("sha256")
        deleted = bool(cmd.get("deleted_at"))
        if not fname:
            continue
        if deleted:
            try:
                (prompt_dir / fname).unlink(missing_ok=True)
                removed += 1
            except Exception:
                pass
            continue
        if not rsha:
            continue
        local_sha = (local.get(fname) or {}).get("sha")
        if local_sha and local_sha == rsha:
            continue
        payload = {"filename": fname}
        if local_sha:
            payload["sha256"] = local_sha
        try:
            resp = request_json("POST", f"{base}/slash-commands/retrieve", payload)
        except Exception as exc:  # noqa: BLE001
            errors += 1
            continue
        data = resp.get("data") if isinstance(resp, dict) else {}
        status = (data or {}).get("status")
        prompt = (data or {}).get("prompt")
        if status == "unchanged":
            continue
        if not isinstance(prompt, str):
            errors += 1
            continue
        try:
            (prompt_dir / fname).write_text(prompt, encoding="utf-8")
            downloaded += 1
        except Exception:  # noqa: BLE001
            errors += 1

    updated_local = load_local()
    baseline = {name: entry["sha"] for name, entry in updated_local.items()}
    remote_names = {cmd["filename"] for cmd in commands if isinstance(cmd, dict) and cmd.get("filename") and not cmd.get("deleted_at")}
    filtered_baseline = {name: sha for name, sha in baseline.items() if name in remote_names}
    save_baseline(filtered_baseline)
    print(
        "ok "
        f"updated={downloaded} "
        f"errors={errors} "
        f"remote={len(commands)} "
        f"local={len(updated_local)} "
        f"removed={removed}"
    )
    sys.exit(0)

if mode == "push":
    if not baseline_file.exists():
        print("skip reason=no-baseline errors=0")
        sys.exit(0)
    try:
        baseline_data = json.loads(baseline_file.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        baseline_data = {}
    if not isinstance(baseline_data, dict):
        baseline_data = {}

    current = load_local(include_content=True)
    changes = []
    for name, entry in current.items():
        if baseline_data.get(name) != entry.get("sha"):
            changes.append(entry)

    if not changes:
        print("ok pushed=0 errors=0")
        sys.exit(0)

    errors = 0
    pushed = 0
    for entry in changes:
        fname = entry.get("filename")
        content = entry.get("content")
        sha = entry.get("sha")
        if not fname or not content or not sha:
            continue
        desc, arg_hint = parse_front_matter(content)
        payload = {
            "filename": fname,
            "prompt": content,
            "sha256": sha,
        }
        if desc:
            payload["description"] = desc
        if arg_hint:
            payload["argument_hint"] = arg_hint
        try:
            resp = request_json("POST", f"{base}/slash-commands/store", payload)
        except Exception:  # noqa: BLE001
            errors += 1
            continue
        data = resp.get("data") if isinstance(resp, dict) else {}
        status = (data or {}).get("status")
        if status in ("created", "updated", "unchanged"):
            pushed += 1
        else:
            errors += 1

    if errors == 0:
        latest_baseline = {name: entry["sha"] for name, entry in current.items()}
        save_baseline(latest_baseline)

    print(
        "ok "
        f"pushed={pushed} "
        f"errors={errors} "
        f"changes={len(changes)} "
        f"local={len(current)}"
    )
    sys.exit(0)

print("skip reason=unknown-mode errors=0")
PY
}

agents_sync_python() {
  local base="$1"
  local api_key="$2"
  local target_file="$3"
  local cafile="$4"
  local current_sha="$5"
  CODEX_SYNC_API_KEY="$api_key" python3 - "$base" "$target_file" "$cafile" "$current_sha" <<'PY'
import hashlib, json, os, pathlib, ssl, sys, urllib.error, urllib.request

base = (sys.argv[1] or "").rstrip("/")
target = pathlib.Path(sys.argv[2]).expanduser()
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
current_sha = (sys.argv[4] or "").strip() if len(sys.argv) > 4 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")


def contexts():
    ctxs = []
    primary = ssl.create_default_context()
    if cafile:
        try:
            primary.load_verify_locations(cafile)
        except Exception:
            primary = None
    if primary is not None:
        try:
            primary.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except AttributeError:
            pass
        ctxs.append(primary)
    try:
        fallback = ssl.create_default_context()
        fallback.verify_flags &= ~ssl.VERIFY_X509_STRICT
        ctxs.append(fallback)
    except Exception:
        pass
    allow_insecure = os.environ.get("CODEX_SYNC_ALLOW_INSECURE", "").lower() in ("1", "true", "yes")
    if allow_insecure:
        try:
            ctxs.append(ssl._create_unverified_context())
        except Exception:
            pass
    return ctxs or [None]


def request_json(method: str, url: str, payload=None):
    data = None
    headers = {"X-API-Key": api_key}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last_err = None
    for ctx in contexts():
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:  # noqa: PERF203
            body = exc.read().decode("utf-8", "ignore")
            reason = f"http-{exc.code}"
            if body:
                reason = f"{reason}:{body.strip()[:80]}"
            raise RuntimeError(reason) from exc
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    raise RuntimeError(f"request failed: {last_err}")


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
        target.write_text(content, encoding="utf-8")
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

sync_slash_commands_pull() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    PROMPT_SYNC_STATUS="missing-config"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    PROMPT_SYNC_STATUS="no-python"
    log_warn "python3 is required for slash command sync; skipping."
    return 1
  fi
  local summary status_code
  set +e
  summary="$(prompt_sync_python pull "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_API_KEY" "$PROMPT_DIR" "$CODEX_SYNC_CA_FILE" "$PROMPT_BASELINE_FILE")"
  status_code=$?
  set -e
  PROMPT_SYNC_STATUS="error"
  if (( status_code != 0 )); then
    local reason=""
    if [[ "$summary" == error\ reason=* ]]; then
      reason="${summary#error reason=}"
    fi
    if [[ "$reason" == http-5* ]] || [[ "$reason" == request_failed* ]]; then
      PROMPT_SYNC_STATUS="offline"
      PROMPT_SYNC_REASON="$reason"
      [[ -n "$summary" ]] && log_warn "Slash command sync offline: $summary" || log_warn "Slash command sync offline."
      PROMPT_PULL_ERRORS=0
    else
      [[ -n "$summary" ]] && log_warn "Slash command sync failed: $summary" || log_warn "Slash command sync failed."
      PROMPT_PULL_ERRORS=1
    fi
    return 1
  fi
  local part
  PROMPT_SYNC_REASON=""
  PROMPT_SYNC_STATUS="${summary%% *}"
  for part in $summary; do
    case "$part" in
      updated=*) PROMPT_PULL_UPDATED="${part#updated=}" ;;
      errors=*) PROMPT_PULL_ERRORS="${part#errors=}" ;;
      remote=*) PROMPT_REMOTE_COUNT="${part#remote=}" ;;
      local=*) PROMPT_LOCAL_COUNT="${part#local=}" ;;
      removed=*) PROMPT_REMOVED="${part#removed=}" ;;
    esac
  done
  return 0
}

sync_agents_pull() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    AGENTS_SYNC_STATUS="missing-config"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    AGENTS_SYNC_STATUS="no-python"
    if (( SYNC_WARNED_NO_PYTHON == 0 )); then
      log_warn "python3 is required for AGENTS.md sync; skipping."
      SYNC_WARNED_NO_PYTHON=1
    fi
    return 1
  fi
  local current_sha=""
  if [[ -f "$AGENTS_PATH" ]]; then
    current_sha="$(python3 - "$AGENTS_PATH" <<'PY'
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
  if (( status_code != 0 )); then
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

config_sync_python() {
  local base="$1"
  local api_key="$2"
  local target_file="$3"
  local cafile="$4"
  local current_sha="$5"
  CODEX_SYNC_API_KEY="$api_key" python3 - "$base" "$target_file" "$cafile" "$current_sha" <<'PY'
import hashlib, json, os, pathlib, ssl, sys, urllib.error, urllib.request

base = (sys.argv[1] or "").rstrip("/")
target = pathlib.Path(sys.argv[2]).expanduser()
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
current_sha = (sys.argv[4] or "").strip() if len(sys.argv) > 4 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")


def contexts():
    ctxs = []
    primary = ssl.create_default_context()
    if cafile:
        try:
            primary.load_verify_locations(cafile)
        except Exception:
            primary = None
    if primary is not None:
        try:
            primary.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except AttributeError:
            pass
        ctxs.append(primary)
    try:
        fallback = ssl.create_default_context()
        fallback.verify_flags &= ~ssl.VERIFY_X509_STRICT
        ctxs.append(fallback)
    except Exception:
        pass
    allow_insecure = os.environ.get("CODEX_SYNC_ALLOW_INSECURE", "").lower() in ("1", "true", "yes")
    if allow_insecure:
        try:
            ctxs.append(ssl._create_unverified_context())
        except Exception:
            pass
    return ctxs or [None]


def request_json(method: str, url: str, payload=None):
    data = None
    headers = {"X-API-Key": api_key}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last_err = None
    for ctx in contexts():
        try:
            with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:  # noqa: PERF203
            body = exc.read().decode("utf-8", "ignore")
            reason = f"http-{exc.code}"
            if body:
                reason = f"{reason}:{body.strip()[:80]}"
            raise RuntimeError(reason) from exc
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    raise RuntimeError(f"request failed: {last_err}")


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
    resp = request_json("POST", f"{base}/config/retrieve", payload)
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
        target.write_text(content, encoding="utf-8")
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
try:
    content = path.read_text(encoding="utf-8", errors="ignore")
except Exception:  # noqa: BLE001
    sys.exit(0)

ansi_csi = re.compile(r"\x1B\[[0-9;?]*[ -/]*[@-~]")
ansi_osc = re.compile(r"\x1B\][^\a\x1b]*[\a\x1b\\]")
control = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def strip_noise(text: str) -> str:
    text = ansi_osc.sub("", text)
    text = ansi_csi.sub("", text)
    text = control.sub("", text)
    return text


cleaned = strip_noise(content)
lines = [ln.strip() for ln in cleaned.splitlines() if "token usage" in ln.lower()]
if not lines:
    sys.exit(0)

pattern = re.compile(
    r"Token usage:\s*total=(?P<total>[\d,]+)\s+input=(?P<input>[\d,]+)(?:\s*\(\+\s*(?P<cached>[\d,]+)\s*cached\))?\s+output=(?P<output>[\d,]+)(?:\s*\(reasoning\s*(?P<reasoning>[\d,]+)\))?",
    re.IGNORECASE,
)
kv_pattern = re.compile(r"\b(total|input|output|cached|reasoning)\s*[:=]\s*([\d,][\d,]*)", re.IGNORECASE)


def clean_int(val: str | None) -> int | None:
    if val is None:
        return None
    try:
        return int(val.replace(",", ""))
    except Exception:
        return None


entries: list[dict[str, object]] = []
for raw in lines:
    entry: dict[str, object] = {}
    safe_line = raw.strip()
    if len(safe_line) > 240:
        safe_line = safe_line[:240] + "…"

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

    if safe_line:
        entry["line"] = safe_line

    if entry:
        entries.append(entry)

if not entries:
    sys.exit(0)

print(json.dumps({"usages": entries}, separators=(",", ":")))
PY
}

post_token_usage_payload() {
  local payload_json="$1"
  if [[ -z "$payload_json" ]]; then
    return 0
  fi
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    log_warn "Usage push skipped: API key or base URL missing"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "Usage push skipped: python3 missing"
    return 1
  fi

  local summary=""
  local status=0
  summary="$(CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" python3 - "$CODEX_SYNC_BASE_URL" "$payload_json" "$CODEX_SYNC_CA_FILE" <<'PY'
import json, os, ssl, sys, urllib.error, urllib.request

base = (sys.argv[1] or "").rstrip("/")
payload_raw = sys.argv[2]
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")

try:
    payload = json.loads(payload_raw)
except Exception:  # noqa: BLE001
    sys.exit(1)

body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
headers = {"Content-Type": "application/json", "X-API-Key": api_key}
url = f"{base}/usage"
req = urllib.request.Request(url, data=body, headers=headers, method="POST")


def build_contexts():
    contexts = []
    try:
        ctx = ssl.create_default_context()
        if cafile:
            ctx.load_verify_locations(cafile)
        try:
            ctx.verify_flags &= ~ssl.VERIFY_X509_STRICT
        except Exception:
            pass
        contexts.append(ctx)
    except Exception:
        pass
    allow_insecure = os.environ.get("CODEX_SYNC_ALLOW_INSECURE", "").lower() in ("1", "true", "yes")
    if allow_insecure:
        try:
            contexts.append(ssl._create_unverified_context())
        except Exception:
            pass
    return contexts or [None]


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


last_err = None
last_code = 1
for ctx in build_contexts():
    try:
        with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:  # noqa: S310
            resp.read(512)
            print(format_summary(payload))
            sys.exit(0)
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        if exc.code == 503 and "disabled" in body.lower():
            print("api disabled")
            sys.exit(40)
        body_snip = (body or "").replace("\n", " ").strip()
        if len(body_snip) > 160:
            body_snip = body_snip[:160] + "…"
        last_err = f"HTTP {exc.code}" + (f": {body_snip}" if body_snip else "")
        last_code = exc.code or 1
        continue
    except Exception as exc:  # noqa: BLE001
        last_err = str(exc)
        continue

if last_err:
    print(last_err)
sys.exit(last_code)
PY
  )" || status=$?
  if (( status == 0 )); then
    log_info "Usage push | ok | ${summary}"
    return 0
  fi

  if (( status == 40 )); then
    log_warn "Usage push skipped: API disabled by administrator"
    return 0
  fi

  local primary_err="$summary"

  # Fallback: retry without the freeform line if present (avoid bad payloads/escape debris)
  if [[ "$payload_json" == *'"line"'* ]]; then
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
      summary=""
      status=0
      summary="$(CODEX_SYNC_API_KEY="$CODEX_SYNC_API_KEY" python3 - "$CODEX_SYNC_BASE_URL" "$fallback_payload" "$CODEX_SYNC_CA_FILE" <<'PY'
import json, os, ssl, sys, urllib.error, urllib.request

base = (sys.argv[1] or "").rstrip("/")
payload_raw = sys.argv[2]
cafile = sys.argv[3] if len(sys.argv) > 3 else ""
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")

payload = json.loads(payload_raw)
body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
headers = {"Content-Type": "application/json", "X-API-Key": api_key}
url = f"{base}/usage"
req = urllib.request.Request(url, data=body, headers=headers, method="POST")

ctx = ssl.create_default_context()
if cafile:
    try:
        ctx.load_verify_locations(cafile)
    except Exception:
        pass
try:
    with urllib.request.urlopen(req, timeout=10, context=ctx) as resp:  # noqa: S310
        resp.read(512)
        print("fallback")
        sys.exit(0)
except urllib.error.HTTPError as exc:  # noqa: PERF203
    body = ""
    try:
        body = exc.read().decode("utf-8", "replace")
    except Exception:
        body = ""
    if exc.code == 503 and "disabled" in body.lower():
        print("api disabled")
        sys.exit(40)
    print(str(exc))
    sys.exit(1)
except Exception as exc:  # noqa: BLE001
    print(str(exc))
    sys.exit(1)
PY
      )" || status=$?
      if (( status == 0 )); then
        log_info "Usage push | ok (fallback) | ${summary}"
        return 0
      elif (( status == 40 )); then
        log_warn "Usage push skipped: API disabled by administrator"
        return 0
      fi
      [[ -z "$primary_err" ]] && primary_err="$summary"
    fi
  fi

  if [[ -z "$primary_err" ]]; then
    primary_err="unknown error"
  fi
  log_warn "Usage push | failed | ${primary_err}"
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
  payload="$(extract_token_usage_payload "$log_path")" || return 0
  if [[ -z "$payload" ]]; then
    return 0
  fi

  last_usage_payload="$payload"
  post_token_usage_payload "$payload" || true
}
