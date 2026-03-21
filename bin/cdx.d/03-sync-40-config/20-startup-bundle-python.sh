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
