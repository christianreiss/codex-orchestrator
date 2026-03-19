
skill_sync_python() {
  local mode="$1"
  local base="$2"
  local api_key="$3"
  local skill_dir="$4"
  local cafile="$5"
  local baseline_file="$6"
  CODEX_SYNC_API_KEY="$api_key" CODEX_FORCE_IPV4="$CODEX_FORCE_IPV4" python3 - "$mode" "$base" "$skill_dir" "$cafile" "$baseline_file" <<'PY'
import hashlib, json, os, pathlib, shutil, sys

py_http_util = os.environ.get("CODEX_PY_HTTP_UTIL", "")
if py_http_util:
    exec(py_http_util, globals())
if "cdx_enable_force_ipv4" in globals():
    cdx_enable_force_ipv4()

mode = sys.argv[1] if len(sys.argv) > 1 else ""
base = (sys.argv[2] or "").rstrip("/")
skill_dir = pathlib.Path(sys.argv[3]).expanduser()
cafile = sys.argv[4] if len(sys.argv) > 4 else ""
baseline_file = pathlib.Path(sys.argv[5]).expanduser() if len(sys.argv) > 5 else skill_dir.parent / ".skill-baseline.json"
api_key = os.environ.get("CODEX_SYNC_API_KEY", "")
_cdx_api_key = api_key
_cdx_cafile = cafile
legacy_skill_dir = pathlib.Path.home() / ".codex" / "skills"

request_json = cdx_short_request_json


def load_local(include_content: bool = False):
    skill_dir.mkdir(parents=True, exist_ok=True)
    skills = {}
    for path in skill_dir.iterdir():
        if not path.is_dir():
            continue
        skill_file = path / "SKILL.md"
        if not skill_file.is_file():
            continue
        slug = path.name
        read_path = skill_file
        try:
            content = read_path.read_text(encoding="utf-8")
        except Exception:  # noqa: BLE001
            continue
        sha = hashlib.sha256(content.encode("utf-8")).hexdigest()
        entry = {"slug": slug, "sha": sha}
        if include_content:
            entry["content"] = content
        skills[slug] = entry
    return skills


atomic_write_text = cdx_atomic_write_text


def save_baseline(skills: dict):
    try:
        baseline_file.parent.mkdir(parents=True, exist_ok=True)
        atomic_write_text(baseline_file, json.dumps(skills, indent=2) + "\n")
    except Exception:  # noqa: BLE001
        pass


def prune_legacy_skill_copy(slug: str) -> int:
    legacy_path = legacy_skill_dir / slug
    try:
        if legacy_path.is_dir():
            shutil.rmtree(legacy_path, ignore_errors=True)
            return 1
        if legacy_path.exists():
            legacy_path.unlink(missing_ok=True)
            return 1
    except Exception:  # noqa: BLE001
        return 0
    return 0


def normalize_sha(value):
    if not isinstance(value, str):
        return None
    value = value.strip().lower()
    if len(value) != 64:
        return None
    if any(ch not in "0123456789abcdef" for ch in value):
        return None
    return value


def extract_metadata(content: str):
    display_name = None
    description = None
    text = content.strip()
    if text.startswith("---"):
        lines = text.splitlines()
        if len(lines) >= 3:
            try:
                end_idx = lines[1:].index("---") + 1
            except ValueError:
                end_idx = -1
            if end_idx > 0:
                for line in lines[1:end_idx]:
                    if ":" not in line:
                        continue
                    key, value = line.split(":", 1)
                    key = key.strip().lower()
                    value = value.strip().strip('"').strip("'")
                    if key == "name":
                        display_name = value
                    elif key == "description":
                        description = value
                return display_name, description
    try:
        data = json.loads(content)
        if isinstance(data, dict):
            display_name = data.get("display_name") or data.get("name")
            description = data.get("description")
    except Exception:  # noqa: BLE001
        pass
    return display_name, description


if not base:
    print("error reason=missing-base")
    sys.exit(1)
if not api_key:
    print("error reason=missing-api-key")
    sys.exit(1)

skill_dir.mkdir(parents=True, exist_ok=True)

if mode == "pull":
    try:
        list_resp = request_json("GET", f"{base}/skills")
    except Exception as exc:  # noqa: BLE001
        print(f"error reason={str(exc).replace(' ', '_')}")
        sys.exit(1)

    skills = []
    if isinstance(list_resp, dict):
        data = list_resp.get("data") or {}
        skills = data.get("skills") or []
    try:
        baseline_data = json.loads(baseline_file.read_text(encoding="utf-8")) if baseline_file.exists() else {}
    except Exception:  # noqa: BLE001
        baseline_data = {}
    if not isinstance(baseline_data, dict):
        baseline_data = {}
    downloaded = 0
    errors = 0
    removed = 0
    local = load_local()
    listed_slugs = set()

    for skill in skills:
        if not isinstance(skill, dict):
            continue
        slug = skill.get("slug")
        rsha = skill.get("sha256")
        deleted = bool(skill.get("deleted_at"))
        if not slug:
            continue
        listed_slugs.add(slug)
        if skill.get("managed"):
            # Legacy managed-skill copies under ~/.codex/skills should not shadow synced skills.
            removed += prune_legacy_skill_copy(slug)
        target_path = skill_dir / slug
        if deleted:
            try:
                if target_path.is_dir():
                    shutil.rmtree(target_path, ignore_errors=True)
                else:
                    target_path.unlink(missing_ok=True)
                removed += 1
            except Exception:
                pass
            continue
        if not rsha:
            continue
        local_sha = (local.get(slug) or {}).get("sha")
        payload = {"slug": slug}
        if local_sha:
            payload["sha256"] = local_sha
            if local_sha == rsha:
                if target_path.is_file():
                    try:
                        content = target_path.read_text(encoding="utf-8")
                        target_path.unlink(missing_ok=True)
                        target_path.mkdir(parents=True, exist_ok=True)
                        target_file = target_path / "SKILL.md"
                        target_file.write_text(content, encoding="utf-8")
                        downloaded += 1
                    except Exception:  # noqa: BLE001
                        errors += 1
                    continue
                continue
        try:
            resp = request_json("POST", f"{base}/skills/retrieve", payload)
        except Exception:
            errors += 1
            continue
        data = resp.get("data") if isinstance(resp, dict) else {}
        status = (data or {}).get("status")
        manifest = (data or {}).get("manifest")
        if status == "unchanged":
            continue
        if not isinstance(manifest, str):
            errors += 1
            continue
        try:
            if target_path.exists() and target_path.is_file():
                target_path.unlink(missing_ok=True)
            target_path.mkdir(parents=True, exist_ok=True)
            target_file = target_path / "SKILL.md"
            target_file.write_text(manifest, encoding="utf-8")
            downloaded += 1
        except Exception:  # noqa: BLE001
            errors += 1

    # Managed skills that disappear from the remote list should be pruned locally on the next sync.
    for slug, baseline_entry in baseline_data.items():
        if not isinstance(slug, str) or slug.strip() == "":
            continue
        if slug in listed_slugs:
            continue
        if not (isinstance(baseline_entry, dict) and baseline_entry.get("managed")):
            continue
        target_path = skill_dir / slug
        try:
            if target_path.is_dir():
                shutil.rmtree(target_path, ignore_errors=True)
            else:
                target_path.unlink(missing_ok=True)
            removed += prune_legacy_skill_copy(slug)
            removed += 1
        except Exception:
            errors += 1

    updated_local = load_local()
    filtered_baseline = {}
    for skill in skills:
        if not isinstance(skill, dict):
            continue
        slug = skill.get("slug")
        if not isinstance(slug, str) or slug.strip() == "" or skill.get("deleted_at"):
            continue
        local_entry = updated_local.get(slug)
        if not isinstance(local_entry, dict):
            continue
        sha = normalize_sha(local_entry.get("sha"))
        if sha is None:
            continue
        if skill.get("managed"):
            filtered_baseline[slug] = {"sha": sha, "managed": True}
        else:
            filtered_baseline[slug] = sha
    save_baseline(filtered_baseline)
    print(
        "ok "
        f"updated={downloaded} "
        f"errors={errors} "
        f"remote={len(skills)} "
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

    def baseline_sha(entry):
        if isinstance(entry, str):
            return normalize_sha(entry)
        if isinstance(entry, dict):
            return normalize_sha(entry.get("sha") or entry.get("sha256"))
        return None

    def baseline_managed(entry):
        return isinstance(entry, dict) and bool(entry.get("managed"))

    current = load_local(include_content=True)
    changes = []
    for slug, entry in current.items():
        baseline_entry = baseline_data.get(slug)
        if baseline_managed(baseline_entry):
            continue
        if baseline_sha(baseline_entry) != entry.get("sha"):
            changes.append(entry)

    if not changes:
        print("ok pushed=0 errors=0")
        sys.exit(0)

    errors = 0
    pushed = 0
    for entry in changes:
        slug = entry.get("slug")
        content = entry.get("content")
        sha = entry.get("sha")
        if not slug or not content or not sha:
            continue
        display_name, description = extract_metadata(content)
        payload = {
            "slug": slug,
            "manifest": content,
            "sha256": hashlib.sha256(content.encode("utf-8")).hexdigest(),
        }
        if display_name:
            payload["display_name"] = display_name
        if description:
            payload["description"] = description
        try:
            resp = request_json("POST", f"{base}/skills/store", payload)
        except Exception:
            errors += 1
            continue
        data = resp.get("data") if isinstance(resp, dict) else {}
        status = (data or {}).get("status")
        if status in ("created", "updated", "unchanged"):
            pushed += 1
        else:
            errors += 1

    if errors == 0:
        latest_baseline = {}
        for name, entry in current.items():
            baseline_entry = baseline_data.get(name)
            if baseline_managed(baseline_entry):
                latest_baseline[name] = {"sha": entry["sha"], "managed": True}
            else:
                latest_baseline[name] = entry["sha"]
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



sync_skills_pull() {
  load_sync_config
  if [[ -z "$CODEX_SYNC_API_KEY" || -z "$CODEX_SYNC_BASE_URL" ]]; then
    SKILL_SYNC_STATUS="missing-config"
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    SKILL_SYNC_STATUS="no-python"
    log_warn "python3 is required for skill sync; skipping."
    return 1
  fi
  local summary status_code
  set +e
  summary="$(skill_sync_python pull "$CODEX_SYNC_BASE_URL" "$CODEX_SYNC_API_KEY" "$SKILL_DIR" "$CODEX_SYNC_CA_FILE" "$SKILL_BASELINE_FILE")"
  status_code=$?
  set -e
  SKILL_SYNC_STATUS="error"
  if (( status_code != 0 )); then
    local reason=""
    if [[ "$summary" == error\ reason=* ]]; then
      reason="${summary#error reason=}"
    fi
    if [[ "$reason" == http-5* ]] || [[ "$reason" == request_failed* ]]; then
      SKILL_SYNC_STATUS="offline"
      SKILL_SYNC_REASON="$reason"
      [[ -n "$summary" ]] && log_warn "Skill sync offline: $summary" || log_warn "Skill sync offline."
      SKILL_PULL_ERRORS=0
    else
      [[ -n "$summary" ]] && log_warn "Skill sync failed: $summary" || log_warn "Skill sync failed."
      SKILL_PULL_ERRORS=1
    fi
    return 1
  fi
  local part
  SKILL_SYNC_REASON=""
  SKILL_SYNC_STATUS="${summary%% *}"
  for part in $summary; do
    case "$part" in
      updated=*) SKILL_PULL_UPDATED="${part#updated=}" ;;
      errors=*) SKILL_PULL_ERRORS="${part#errors=}" ;;
      remote=*) SKILL_REMOTE_COUNT="${part#remote=}" ;;
      local=*) SKILL_LOCAL_COUNT="${part#local=}" ;;
      removed=*) SKILL_REMOVED="${part#removed=}" ;;
    esac
  done
  return 0
}
