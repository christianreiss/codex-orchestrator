
prompt_sync_python() {
  local mode="$1"
  local base="$2"
  local api_key="$3"
  local prompt_dir="$4"
  local cafile="$5"
  local baseline_file="$6"
  CODEX_SYNC_API_KEY="$api_key" python3 - "$mode" "$base" "$prompt_dir" "$cafile" "$baseline_file" <<'PY'
import hashlib, json, os, pathlib, shutil, sys

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())

mode = sys.argv[1] if len(sys.argv) > 1 else ""
base = (sys.argv[2] or "").rstrip("/")
prompt_dir = pathlib.Path(sys.argv[3]).expanduser()
cafile = sys.argv[4] if len(sys.argv) > 4 else ""
baseline_file = pathlib.Path(sys.argv[5]).expanduser() if len(sys.argv) > 5 else prompt_dir.parent / ".prompt-baseline.json"
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")
_cdx_api_key = api_key
_cdx_cafile = cafile

request_json = cdx_short_request_json


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


atomic_write_text = cdx_atomic_write_text


def save_baseline(prompts: dict):
    try:
        baseline_file.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(baseline_file, json.dumps(prompts, indent=2) + "\n")
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
