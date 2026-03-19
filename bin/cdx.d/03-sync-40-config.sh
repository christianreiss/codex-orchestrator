
config_sync_python() {
  local base="$1"
  local api_key="$2"
  local target_file="$3"
  local cafile="$4"
  local current_sha="$5"
  local username="${CURRENT_USER:-}"
  local home_path="${HOME:-}"
  if [[ -z "$home_path" && -n "$username" ]] && command -v getent >/dev/null 2>&1; then
    home_path="$(getent passwd "$username" | cut -d: -f6 2>/dev/null || true)"
  fi
  CODEX_CONFIG_USERNAME="$username" CODEX_CONFIG_HOME="$home_path" CODEX_SYNC_API_KEY="$api_key" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$base" "$target_file" "$cafile" "$current_sha" <<'PY'
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
username = os.environ.get("CODEX_CONFIG_USERNAME", "").strip()
home = os.environ.get("CODEX_CONFIG_HOME", "").strip()
if username:
    payload["username"] = username
if home:
    payload["home"] = home

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

startup_sync_bundle_python() {
  local base="$1"
  local api_key="$2"
  local prompt_dir="$3"
  local skill_dir="$4"
  local agents_file="$5"
  local config_file="$6"
  local cafile="$7"
  local prompt_baseline_file="$8"
  local skill_baseline_file="$9"
  local username="${10}"
  local home_path="${11}"
  local hostname="${12}"
  CODEX_SYNC_API_KEY="$api_key" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" CODEX_SYNC_USERNAME="$username" CODEX_SYNC_HOME="$home_path" CODEX_SYNC_HOSTNAME="$hostname" python3 - "$base" "$prompt_dir" "$skill_dir" "$agents_file" "$config_file" "$cafile" "$prompt_baseline_file" "$skill_baseline_file" <<'PY'
import hashlib
import json
import os
import pathlib
import shutil
import sys

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

base = (sys.argv[1] or "").rstrip("/")
prompt_dir = pathlib.Path(sys.argv[2]).expanduser()
skill_dir = pathlib.Path(sys.argv[3]).expanduser()
agents_file = pathlib.Path(sys.argv[4]).expanduser()
config_file = pathlib.Path(sys.argv[5]).expanduser()
cafile = sys.argv[6] if len(sys.argv) > 6 else ""
prompt_baseline = pathlib.Path(sys.argv[7]).expanduser() if len(sys.argv) > 7 else prompt_dir.parent / ".prompt-baseline.json"
skill_baseline = pathlib.Path(sys.argv[8]).expanduser() if len(sys.argv) > 8 else skill_dir.parent / ".skill-baseline.json"
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


def scan_prompts():
    prompt_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for path in prompt_dir.iterdir():
        if not path.is_file():
            continue
        sha = file_sha(path)
        if not sha:
            continue
        items.append({"filename": path.name, "sha256": sha})
    items.sort(key=lambda item: item.get("filename", ""))
    return items


def scan_skills():
    skill_dir.mkdir(parents=True, exist_ok=True)
    items = []
    for path in skill_dir.iterdir():
        if not path.is_dir():
            continue
        skill_file = path / "SKILL.md"
        if not skill_file.is_file():
            continue
        read_path = skill_file
        slug = path.name
        sha = file_sha(read_path)
        if not sha:
            continue
        items.append({"slug": slug, "sha256": sha})
    items.sort(key=lambda item: item.get("slug", ""))
    return items


def write_prompt_baseline(remote):
    data = {}
    if isinstance(remote, list):
        for entry in remote:
            if not isinstance(entry, dict):
                continue
            filename = entry.get("filename")
            sha = normalize_sha(entry.get("sha256"))
            deleted_at = entry.get("deleted_at")
            if not isinstance(filename, str) or filename.strip() == "":
                continue
            if deleted_at:
                continue
            if sha is None:
                continue
            data[filename] = sha
    try:
        prompt_baseline.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(prompt_baseline, json.dumps(data, indent=2) + "\n")
    except Exception:
        pass


def write_skill_baseline(remote):
    data = {}
    if isinstance(remote, list):
        for entry in remote:
            if not isinstance(entry, dict):
                continue
            slug = entry.get("slug")
            sha = normalize_sha(entry.get("sha256"))
            deleted_at = entry.get("deleted_at")
            if not isinstance(slug, str) or slug.strip() == "":
                continue
            if deleted_at:
                continue
            if sha is None:
                continue
            if entry.get("managed"):
                data[slug] = {"sha": sha, "managed": True}
            else:
                data[slug] = sha
    try:
        skill_baseline.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(skill_baseline, json.dumps(data, indent=2) + "\n")
    except Exception:
        pass


def apply_prompt_changes(block):
    changed = block.get("changed") if isinstance(block, dict) else []
    remote = block.get("remote") if isinstance(block, dict) else []
    updated = 0
    removed = 0
    errors = 0

    if isinstance(changed, list):
        for entry in changed:
            if not isinstance(entry, dict):
                continue
            filename = entry.get("filename")
            if not isinstance(filename, str) or filename.strip() == "":
                continue
            status = str(entry.get("status") or "").strip().lower()
            target = prompt_dir / filename

            if status == "deleted":
                try:
                    target.unlink(missing_ok=True)
                    removed += 1
                except Exception:
                    errors += 1
                continue

            prompt = entry.get("prompt")
            if not isinstance(prompt, str):
                errors += 1
                continue
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(prompt, encoding="utf-8")
                updated += 1
            except Exception:
                errors += 1

    write_prompt_baseline(remote if isinstance(remote, list) else [])
    local_count = len(scan_prompts())

    return {
        "status": "ok",
        "updated": updated,
        "removed": removed,
        "errors": errors,
        "remote": len(remote) if isinstance(remote, list) else 0,
        "local": local_count,
    }


def apply_skill_changes(block):
    changed = block.get("changed") if isinstance(block, dict) else []
    remote = block.get("remote") if isinstance(block, dict) else []
    updated = 0
    removed = 0
    errors = 0
    listed_slugs = set()

    if isinstance(changed, list):
        for entry in changed:
            if not isinstance(entry, dict):
                continue
            slug = entry.get("slug")
            if not isinstance(slug, str) or slug.strip() == "":
                continue
            status = str(entry.get("status") or "").strip().lower()
            target_dir = skill_dir / slug

            if status == "deleted":
                try:
                    if target_dir.exists() and target_dir.is_file():
                        target_dir.unlink(missing_ok=True)
                    elif target_dir.exists():
                        shutil.rmtree(target_dir, ignore_errors=True)
                    removed += 1
                except Exception:
                    errors += 1
                continue

            manifest = entry.get("manifest")
            if not isinstance(manifest, str):
                errors += 1
                continue

            try:
                if target_dir.exists() and target_dir.is_file():
                    target_dir.unlink(missing_ok=True)
                target_dir.mkdir(parents=True, exist_ok=True)
                (target_dir / "SKILL.md").write_text(manifest, encoding="utf-8")
                updated += 1
            except Exception:
                errors += 1

    if isinstance(remote, list):
        for entry in remote:
            if not isinstance(entry, dict):
                continue
            slug = entry.get("slug")
            if not isinstance(slug, str) or slug.strip() == "":
                continue
            listed_slugs.add(slug)

    try:
        baseline_data = json.loads(skill_baseline.read_text(encoding="utf-8")) if skill_baseline.exists() else {}
    except Exception:
        baseline_data = {}
    if not isinstance(baseline_data, dict):
        baseline_data = {}

    # Managed skills that disappear from the remote list should be pruned locally on the next sync.
    for slug, baseline_entry in baseline_data.items():
        if not isinstance(slug, str) or slug.strip() == "":
            continue
        if slug in listed_slugs:
            continue
        if not (isinstance(baseline_entry, dict) and baseline_entry.get("managed")):
            continue
        target_dir = skill_dir / slug
        try:
            if target_dir.exists() and target_dir.is_file():
                target_dir.unlink(missing_ok=True)
            elif target_dir.exists():
                shutil.rmtree(target_dir, ignore_errors=True)
            removed += 1
        except Exception:
            errors += 1

    write_skill_baseline(remote if isinstance(remote, list) else [])
    local_count = len(scan_skills())

    return {
        "status": "ok",
        "updated": updated,
        "removed": removed,
        "errors": errors,
        "remote": len(remote) if isinstance(remote, list) else 0,
        "local": local_count,
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


prompt_items = scan_prompts()
skill_items = scan_skills()
agents_sha = file_sha(agents_file) if agents_file.is_file() else None
config_sha = file_sha(config_file) if config_file.is_file() else None

status_payload = {
    "include_auth": False,
    "host_user": {
        "username": username,
        "hostname": hostname,
    },
    "slash_commands": {
        "items": prompt_items,
    },
    "skills": {
        "items": skill_items,
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

prompt_result = apply_prompt_changes(data.get("slash_commands") if isinstance(data.get("slash_commands"), dict) else {})
skill_result = apply_skill_changes(data.get("skills") if isinstance(data.get("skills"), dict) else {})
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
                "prompt": prompt_result,
                "skill": skill_result,
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
            "prompt": prompt_result,
            "skill": skill_result,
            "agents": agents_result,
            "config": config_result,
        },
        separators=(",", ":"),
    )
)
sys.exit(0)
PY
}

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
    m = re.search(r'(?m)^\\[' + re.escape(name) + r'\\]\\s*$', raw)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r'(?m)^\\[', raw[start:])
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
