#!/usr/bin/env bash
# Shared stop-before-start cutover. Caller initializes INSTANCE_COMPOSE/ENV_PATH.
# Bundles contain database contents and credentials: never print their contents.
OWNER_CUTOVER_DIR="${OWNER_CUTOVER_DIR:-}"

owner_cutover_phase() {
  [[ -n "$OWNER_CUTOVER_DIR" ]] || return 0
  (umask 077; printf '%s\n' "$1" > "$OWNER_CUTOVER_DIR/phase.tmp"; mv "$OWNER_CUTOVER_DIR/phase.tmp" "$OWNER_CUTOVER_DIR/phase")
}

owner_cutover_storage_lock() {
  # Retain the inode: the running API may already hold its kernel lock.
  python3 - "$1" "${2:-10001:10001}" <<'PYSTORAGE'
import os, re, stat, sys
identity = sys.argv[2]
if not re.fullmatch(r'[0-9]+(?::[0-9]+)?', identity):
    sys.exit('[cutover] api user must be numeric to prepare storage ownership')
parts = identity.split(':')
uid, gid = int(parts[0]), int(parts[-1])
path = os.path.join(sys.argv[1], '.control-plane-owner.lock')
fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
try:
    current = os.fstat(fd)
    if not stat.S_ISREG(current.st_mode):
        sys.exit('[cutover] storage lock must be a regular file')
    if (current.st_uid, current.st_gid) != (uid, gid):
        os.fchown(fd, uid, gid)
    if stat.S_IMODE(current.st_mode) != 0o600:
        os.fchmod(fd, 0o600)
finally:
    os.close(fd)
PYSTORAGE
}

owner_cutover_prepare() {
  # Recovery metadata only. Backups are Bareos' job and rollback is git: no
  # database dumps, storage archives, credential copies or rollback image tags.
  local base="${CODEX_DEPLOY_CUTOVER_DIR:-$INSTANCE_ROOT/cutovers}" project store command
  local -a required=(python3 flock realpath)
  for command in "${required[@]}"; do
    command -v "$command" >/dev/null || { printf '[cutover] required command missing: %s\n' "$command" >&2; return 1; }
  done
  # Reuse the CLI's inherited descriptor, or hold the same instance lock when
  # deploy/install is invoked directly. Retain it through replacement startup.
  if [[ "$(readlink /proc/self/fd/9 2>/dev/null || true)" != "$INSTANCE_ROOT/.orchestrator.lock" ]]; then
    exec 9>"$INSTANCE_ROOT/.orchestrator.lock" || return 1
  fi
  flock -n 9 || { printf '[cutover] another instance operation owns the deployment lock\n' >&2; return 1; }
  mkdir -p "$base" || return 1
  OWNER_CUTOVER_DIR="$(mktemp -d "$base/cutover-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")" || return 1
  chmod 700 "$OWNER_CUTOVER_DIR" || return 1
  export OWNER_CUTOVER_DIR
  # A fresh shell preserves errexit even when the caller uses `prepare || fail`.
  bash "${BASH_SOURCE[0]}" --snapshot "$INSTANCE_ROOT" "$ENV_PATH" "$OWNER_CUTOVER_DIR" "${INSTANCE_COMPOSE[@]}"
}

_owner_cutover_snapshot() {
  (
    set -euo pipefail
    umask 077
    local container service image phase containers api_user config_json container_json
    # A failed snapshot has changed no durable application state. Resume only
    # the exact containers that were running before this invocation.
    trap 'code=$?; if (( code != 0 )); then
      phase="$(cat "$OWNER_CUTOVER_DIR/phase" 2>/dev/null || true)"
      if [[ "$phase" == quiescing ]]; then
        if [[ -f "$OWNER_CUTOVER_DIR/legacy-drain-created" ]]; then
          rm -f -- "$(cat "$OWNER_CUTOVER_DIR/legacy-drain-created")"
        fi
        while IFS= read -r container; do [[ -z "$container" ]] || docker start "$container" >/dev/null || printf "[cutover] could not resume container %s; inspect its status\n" "$container" >&2; done < "$OWNER_CUTOVER_DIR/running-writers.txt"
      fi
      printf "[cutover] snapshot failed; inspect %s (exit %s)\n" "$OWNER_CUTOVER_DIR" "$code" >&2
    fi' EXIT
    config_json="$("${INSTANCE_COMPOSE[@]}" config --format json)"
    printf '%s' "$config_json" | python3 -c 'import json,sys
c=json.load(sys.stdin)
c={"name":c["name"],"services":{name:{key:value[key] for key in ["image","user","volumes"] if key in value} for name,value in c["services"].items()}}
json.dump(c,sys.stdout)' > "$OWNER_CUTOVER_DIR/compose.json"
    project="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["name"])' "$OWNER_CUTOVER_DIR/compose.json")"
    store="$(python3 -c 'import json,sys; c=json.load(open(sys.argv[1]));print(next(v["source"] for v in c["services"]["api"]["volumes"] if v.get("target")=="/app/storage"))' "$OWNER_CUTOVER_DIR/compose.json")"
    [[ -n "$project" && -d "$store" ]] || { printf '[cutover] missing project/store\n' >&2; exit 1; }
    case "$(realpath "$OWNER_CUTOVER_DIR")/" in "$(realpath "$store")/"*) printf '[cutover] cutover directory must be outside application storage\n' >&2; exit 1;; esac
    printf '%s\n' "$store" > "$OWNER_CUTOVER_DIR/store-path.txt"
    : > "$OWNER_CUTOVER_DIR/running-writers.txt"
    : > "$OWNER_CUTOVER_DIR/previous-images.tsv"
    for service in api quota-cron media-worker; do
      containers="$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")"
      while IFS= read -r container; do
        [[ -n "$container" ]] || continue
        printf '%s\n' "$container" >> "$OWNER_CUTOVER_DIR/running-writers.txt"
        container_json="$(docker inspect "$container")"
        printf '%s' "$container_json" | python3 -c 'import json,sys
rows=json.load(sys.stdin)
rows=[{key:row[key] for key in ["Id","Image","Mounts"] if key in row} for row in rows]
json.dump(rows,sys.stdout)' > "$OWNER_CUTOVER_DIR/container-$service-$container.json"
        if [[ "$service" == api ]]; then
          printf '%s\0%s' "$config_json" "$container_json" | python3 -c 'import json, os, sys
raw_config, raw_previous = sys.stdin.read().split(chr(0), 1)
config = json.loads(raw_config)["services"]["api"]
previous = json.loads(raw_previous)[0]
expected = next(v['"'"'source'"'"'] for v in config['"'"'volumes'"'"'] if v.get('"'"'target'"'"') == '"'"'/app/storage'"'"')
actual = next(v['"'"'Source'"'"'] for v in previous['"'"'Mounts'"'"'] if v.get('"'"'Destination'"'"') == '"'"'/app/storage'"'"')
env = config.get('"'"'environment'"'"', {})
if isinstance(env, list): env = dict(item.split('"'"'='"'"', 1) for item in env if '"'"'='"'"' in item)
old_env = dict(item.split('"'"'='"'"', 1) for item in previous['"'"'Config'"'"']['"'"'Env'"'"'] if '"'"'='"'"' in item)
if os.path.realpath(expected) != os.path.realpath(actual) or any(str(env.get(key, '"'"''"'"')) != str(old_env.get(key, '"'"''"'"')) for key in ['"'"'DB_HOST'"'"', '"'"'DB_PORT'"'"', '"'"'DB_DATABASE'"'"', '"'"'DB_USERNAME'"'"', '"'"'DB_PASSWORD'"'"', '"'"'DATABASE_URL'"'"']):
    sys.exit('"'"'[cutover] active API storage/database differs from deployment configuration; reconcile the target before stopping writers'"'"')'
        fi
        image="$(docker inspect --format '{{.Image}}' "$container")"
        printf '%s\t%s\t%s\n' "$service" "$container" "$image" >> "$OWNER_CUTOVER_DIR/previous-images.tsv"
      done <<< "$containers"
    done
    api_user="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["services"]["api"].get("user") or "10001:10001")' "$OWNER_CUTOVER_DIR/compose.json")"
    owner_cutover_storage_lock "$store" "$api_user"
    owner_cutover_phase quiescing
    local -a capture_command=(python3 "$(dirname "${BASH_SOURCE[0]}")/owner-drain-cutover.py") capture_compose=("${INSTANCE_COMPOSE[@]}")
    if [[ "${capture_compose[0]}" == env ]]; then
      local compose_start=1
      while [[ "${capture_compose[$compose_start]}" == *=* ]]; do compose_start=$((compose_start + 1)); done
      # Keep credentials in the capture process environment, not its long-lived argv.
      capture_command=("${capture_compose[@]:0:$compose_start}" "${capture_command[@]}")
      capture_compose=("${capture_compose[@]:$compose_start}")
    fi
    "${capture_command[@]}" \
      --store "$store" --writers "$OWNER_CUTOVER_DIR/running-writers.txt" \
      --project "$project" --user "$api_user" --journal "$OWNER_CUTOVER_DIR" \
      -- "${capture_compose[@]}"
    date -u +%Y-%m-%dT%H:%M:%SZ > "$OWNER_CUTOVER_DIR/quiescent-at.txt"
    owner_cutover_phase quiescent
    printf '[cutover] quiescent; recovery metadata: %s\n' "$OWNER_CUTOVER_DIR" >&2
  )
}

owner_cutover_resume_previous() {
  [[ -n "$OWNER_CUTOVER_DIR" ]] || return 0
  owner_cutover_phase replacement-started
  local container
  while IFS= read -r container; do [[ -z "$container" ]] || docker start "$container" >/dev/null; done < "$OWNER_CUTOVER_DIR/running-writers.txt"
}

if [[ "${BASH_SOURCE[0]}" == "$0" && "${1:-}" == --snapshot ]]; then
  set -euo pipefail
  INSTANCE_ROOT="$2" ENV_PATH="$3" OWNER_CUTOVER_DIR="$4"
  shift 4
  INSTANCE_COMPOSE=("$@")
  _owner_cutover_snapshot
fi
