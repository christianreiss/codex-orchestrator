#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

backup=0
cleanup=1
pull_rebase=0
skip_git=0
no_wait=0
skip_wrappers=0
wrappers_published=0
wrapper_version=""
profiles=()
services=()

usage() {
  cat <<'EOF'
Usage: scripts/deploy.sh [options]

Build, restart, and verify the codex-orchestrator Docker stack.

Options:
  --backup             Write a one-off MySQL dump before rebuilding.
  --no-cleanup         Skip Docker image/builder pruning after deploy.
  --pull-rebase        Run git pull --rebase before deploying.
  --skip-git           Skip clean-worktree and git pull checks.
  --profile NAME       Enable a docker compose profile, e.g. caddy.
  --caddy              Shortcut for --profile caddy.
  --service NAME       Deploy only the named compose service. Repeatable.
  --no-wait            Do not pass docker compose up --wait.
  --skip-wrappers      Do not build/publish the cxx wrapper matrix.
  -h, --help           Show this help.

Wrappers:
  When the api is deployed, the cxx wrapper matrix is built in the
  wrappers/Dockerfile.build toolchain container and published whenever
  VERSION in wrappers/Makefile is not yet the served version. The binaries
  embed the active signing key from the database; the api is then recreated so
  hosts are offered the new version. Bump VERSION to ship wrapper changes.

Environment:
  CODEX_DEPLOY_BACKUP_DIR  Directory for --backup dumps (default: ./backups).
EOF
}

log() {
  printf '[deploy] %s\n' "$*"
}

fail() {
  printf '[deploy] ERROR: %s\n' "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --backup)
      backup=1
      ;;
    --no-cleanup)
      cleanup=0
      ;;
    --pull-rebase)
      pull_rebase=1
      ;;
    --skip-git)
      skip_git=1
      ;;
    --profile)
      [[ $# -ge 2 ]] || fail "--profile requires a value"
      profiles+=("$2")
      shift
      ;;
    --caddy)
      profiles+=("caddy")
      ;;
    --service)
      [[ $# -ge 2 ]] || fail "--service requires a value"
      services+=("$2")
      shift
      ;;
    --no-wait)
      no_wait=1
      ;;
    --skip-wrappers)
      skip_wrappers=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
  shift
done

cd "${repo_root}"

require_cmd git
require_cmd docker
require_cmd curl

if ! docker compose version >/dev/null 2>&1; then
  fail "docker compose v2 is required"
fi

compose=(docker compose)
for profile in "${profiles[@]}"; do
  compose+=(--profile "${profile}")
done

if [[ "${skip_git}" -eq 0 ]]; then
  [[ -d .git ]] || fail "not a git checkout: ${repo_root}"

  if ! git diff --quiet --ignore-submodules --; then
    fail "worktree has unstaged changes; commit/stash them or use --skip-git"
  fi
  if ! git diff --cached --quiet --ignore-submodules --; then
    fail "worktree has staged changes; commit/stash them or use --skip-git"
  fi

  before_rev="$(git rev-parse --short HEAD)"
  if [[ "${pull_rebase}" -eq 1 ]]; then
    upstream_ref="$(git rev-parse --abbrev-ref '@{upstream}')"
    log "pulling with rebase from ${upstream_ref}"
    git pull --rebase
  else
    log "checking upstream with fast-forward pull"
    git pull --ff-only
  fi
  after_rev="$(git rev-parse --short HEAD)"
  if [[ "${before_rev}" != "${after_rev}" ]]; then
    log "updated git revision ${before_rev} -> ${after_rev}"
  else
    log "git revision unchanged (${after_rev})"
  fi
else
  log "skipping git checks"
fi

deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ "${backup}" -eq 1 ]]; then
  backup_dir="${CODEX_DEPLOY_BACKUP_DIR:-${repo_root}/backups}"
  mkdir -p "${backup_dir}"
  backup_file="${backup_dir}/codex-orchestrator-$(date -u +%Y%m%dT%H%M%SZ).sql"
  log "writing MySQL backup to ${backup_file}"
  if ! "${compose[@]}" ps -q mysql >/dev/null 2>&1; then
    fail "mysql service is not available for backup"
  fi
  # shellcheck disable=SC2016 # Expand MYSQL_* inside the mysql container.
  (
    umask 077
    "${compose[@]}" exec -T mysql sh -lc \
      'mysqldump --no-tablespaces -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"' \
      > "${backup_file}"
  )
  log "backup complete ($(wc -c < "${backup_file}") bytes)"
fi

deploys_api=1
if [[ "${#services[@]}" -gt 0 ]]; then
  deploys_api=0
  for service in "${services[@]}"; do
    [[ "${service}" == "api" ]] && deploys_api=1
  done
fi

# --- cxx wrapper matrix -------------------------------------------------------
# The api serves wrapper binaries from DATA_ROOT/store/wrapper/v2/bin and
# projects the served version into `versions` at boot. Publishing here, before
# the api is (re)started, is what makes a VERSION bump reach the fleet with no
# separate release step. bin/install.sh's wrappers step is not reusable for
# this: it is written for a first install and refuses a bump once the private
# key has been imported into the database.

wrapper_platforms=(linux-amd64 linux-arm64 darwin-amd64 darwin-arm64)

read_wrapper_version() {
  awk '/^VERSION[[:space:]]*\?=/ { sub(/^VERSION[[:space:]]*\?=[[:space:]]*/, ""); sub(/^v/, ""); print; exit }' \
    "${repo_root}/wrappers/Makefile"
}

# The host path compose actually mounts at /app/storage, so .env and the
# compose default are honoured exactly as the running api sees them.
wrapper_publish_root() {
  "${compose[@]}" config --format json | python3 -c '
import json, sys
cfg = json.load(sys.stdin)
for vol in cfg.get("services", {}).get("api", {}).get("volumes", []):
    if isinstance(vol, dict) and vol.get("target") == "/app/storage" and vol.get("source"):
        print(vol["source"].rstrip("/") + "/wrapper/v2/bin")
        break
'
}

manifest_current() {
  python3 -c '
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("current", ""))
except Exception:
    print("")
' "$1"
}

# Prints: current | installed (built, not current) | missing
wrapper_publish_state() {
  local root="$1" version="$2" plat all_current=1 all_built=1
  for plat in "${wrapper_platforms[@]}"; do
    [[ -x "${root}/cxx/${plat}/v${version}/cxx" ]] || all_built=0
    [[ "$(manifest_current "${root}/cxx/${plat}/manifest.json")" == "${version}" ]] || all_current=0
  done
  if (( all_built && all_current )); then
    echo current
  elif (( all_built )); then
    echo installed
  else
    echo missing
  fi
}

# The binaries must embed the key the server signs configs with. That key is
# the single active row in wrapper_signing_keys; a key file on disk, if one
# exists, must agree with it.
wrapper_signing_pem() {
  local out
  # shellcheck disable=SC2016 # Expand MYSQL_* inside the mysql container.
  out="$("${compose[@]}" exec -T mysql sh -lc \
    'mysql -N -B -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT REPLACE(public_key, CHAR(10), \"|\") FROM wrapper_signing_keys WHERE active = 1"' \
    2>/dev/null)" || fail "could not read wrapper_signing_keys (is mysql up?)"
  local count
  count="$(printf '%s\n' "${out}" | grep -c 'BEGIN PUBLIC KEY' || true)"
  if [[ "${count}" -eq 0 ]]; then
    fail "no active wrapper signing key in the database; run bin/install.sh --only signer"
  fi
  if [[ "${count}" -gt 1 ]]; then
    fail "${count} active wrapper signing keys (rotation in progress); publish wrappers per docs/wrapper-v2-architecture.md or rerun with --skip-wrappers"
  fi
  printf '%s\n' "${out}" | tr '|' '\n' | sed '/^[[:space:]]*$/d'
}

pem_body() {
  grep -v -- '-----' | tr -d '[:space:]'
}

# Warn when wrapper sources moved on but VERSION did not: hosts keep the old
# binary until someone bumps it, which is easy to miss.
warn_unbumped_wrapper() {
  local root="$1" version="$2" arch binary commit
  case "$(uname -m)" in
    x86_64|amd64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) return 0 ;;
  esac
  binary="${root}/cxx/linux-${arch}/v${version}/cxx"
  [[ "$(uname -s)" == "Linux" && -x "${binary}" ]] || return 0
  commit="$("${binary}" --version 2>/dev/null | sed -n 's/.*(commit \([0-9a-f]\{7,40\}\),.*/\1/p' | head -n1)"
  [[ -n "${commit}" ]] || return 0
  git -C "${repo_root}" cat-file -e "${commit}^{commit}" 2>/dev/null || return 0
  if ! git -C "${repo_root}" diff --quiet "${commit}" HEAD -- wrappers/cxx wrappers/Makefile; then
    log "WARNING: wrapper sources changed since ${commit}, but VERSION ${version} is already published."
    log "WARNING: hosts keep the old binary; bump VERSION in wrappers/Makefile to ship the changes."
  fi
}

publish_wrappers() {
  local version="$1" root="$2" state stage pem key_file key_b64 img commit plat body
  state="$(wrapper_publish_state "${root}" "${version}")"
  case "${state}" in
    current)
      log "wrappers current (cxx ${version})"
      warn_unbumped_wrapper "${root}" "${version}"
      return 0
      ;;
    installed)
      log "WARNING: cxx ${version} is published but not current in every manifest (manual rollback?); leaving wrappers untouched"
      return 0
      ;;
  esac

  require_cmd python3
  log "building cxx ${version} wrapper matrix"
  pem="$(wrapper_signing_pem)"
  body="$(printf '%s\n' "${pem}" | pem_body)"
  [[ -n "${body}" ]] || fail "active wrapper signing key is empty"
  key_file="${root%/bin}/keys/installation-signing.ed25519.pub"
  if [[ -f "${key_file}" && "$(pem_body < "${key_file}")" != "${body}" ]]; then
    fail "${key_file} does not match the active signing key in the database"
  fi

  stage="$(mktemp -d)"
  # shellcheck disable=SC2064 # Expand the path now; the variable is local.
  trap "rm -rf '${stage}'" EXIT
  mkdir -p "${stage}/keys" "${stage}/out"
  ( umask 077; printf '%s\n' "${pem}" > "${stage}/keys/signing.pub" )
  chmod 0755 "${stage}" "${stage}/out"
  chmod 0644 "${stage}/keys/signing.pub"

  img="codex-orchestrator/wrapper-build:${version}"
  # --pull: the image pins GOTOOLCHAIN=local, so a stale cached golang:1.25
  # older than wrappers/cxx/go.mod fails instead of downloading a toolchain.
  docker build --pull -q -f "${repo_root}/wrappers/Dockerfile.build" -t "${img}" "${repo_root}/wrappers" >/dev/null \
    || fail "could not build the wrapper toolchain image"
  commit="$(git -C "${repo_root}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -e HOME=/tmp \
    -e GOTELEMETRY=off \
    -v "${repo_root}:/src" \
    -v "${stage}/out:/stage" \
    -v "${stage}/keys:/keys:ro" \
    -w /src/wrappers \
    "${img}" \
    make release VERSION="${version}" COMMIT="${commit}" OUTROOT=/stage PUBLIC_KEY_FILE=/keys/signing.pub \
    || fail "wrapper build failed"

  # An unreadable PUBLIC_KEY_FILE makes the Makefile fall back to the tracked
  # development key without an error, and that key is compiled into every
  # binary anyway. So look for the base64 value the build injects via ldflags:
  # only a build that actually read this key carries it.
  key_b64="$(base64 -w0 "${stage}/keys/signing.pub" 2>/dev/null || base64 "${stage}/keys/signing.pub" | tr -d '\n')"
  for plat in "${wrapper_platforms[@]}"; do
    grep -aFq "${key_b64}" "${stage}/out/cxx/${plat}/v${version}/cxx" \
      || fail "staged ${plat} binary does not embed the active signing key; refusing to publish"
  done

  mkdir -p "${root}"
  python3 "${repo_root}/wrappers/scripts/publish-release.py" "${stage}/out" "${root}" "${version}" \
    || fail "publish failed; if v${version} directories were created without manifests, remove them or bump VERSION"
  chmod -R a+rX "${root}" 2>/dev/null || true
  rm -rf "${stage}"
  trap - EXIT
  wrappers_published=1
  log "published cxx ${version} to ${root}"
}

if [[ "${skip_wrappers}" -eq 1 ]]; then
  log "skipping wrappers (--skip-wrappers)"
elif [[ "${deploys_api}" -eq 0 ]]; then
  log "skipping wrappers (api not in --service list)"
else
  wrapper_version="$(read_wrapper_version)"
  [[ -n "${wrapper_version}" ]] || fail "could not read VERSION from wrappers/Makefile"
  wrapper_root="$(wrapper_publish_root)"
  [[ -n "${wrapper_root}" ]] || fail "could not resolve the api /app/storage mount from docker compose config"
  publish_wrappers "${wrapper_version}" "${wrapper_root}"
fi

build_args=(build)
if [[ "${#services[@]}" -gt 0 ]]; then
  build_args+=("${services[@]}")
fi
log "building compose services"
"${compose[@]}" "${build_args[@]}"

# Migrate with the freshly built image, before any listener opens. The API also
# migrates on boot (RUN_MIGRATIONS_ON_BOOT), but doing it here keeps a slow
# ALTER out of the container healthcheck window, so `up --wait` cannot mark a
# successfully-migrating api unhealthy.
if [[ "${deploys_api}" -eq 1 ]]; then
  log "applying database migrations"
  "${compose[@]}" run --rm -T api node migrate.js
else
  log "skipping database migrations (api not in --service list)"
fi

up_args=(up -d --remove-orphans)
if [[ "${no_wait}" -eq 0 ]] && docker compose up --help | grep -q -- '--wait'; then
  up_args+=(--wait)
fi
if [[ "${#services[@]}" -gt 0 ]]; then
  up_args+=("${services[@]}")
fi
log "starting compose services"
"${compose[@]}" "${up_args[@]}"

if [[ "${wrappers_published}" -eq 1 ]]; then
  # The api projects the served wrapper version into `versions` only at boot,
  # and a wrappers-only commit does not change the api image.
  log "recreating api so hosts are offered cxx ${wrapper_version}"
  recreate_args=(up -d --force-recreate)
  if [[ "${no_wait}" -eq 0 ]] && docker compose up --help | grep -q -- '--wait'; then
    recreate_args+=(--wait)
  fi
  "${compose[@]}" "${recreate_args[@]}" api
fi

log "compose status"
"${compose[@]}" ps

log "checking database"
# shellcheck disable=SC2016 # Expand MYSQL_* inside the mysql container.
"${compose[@]}" exec -T mysql sh -lc \
  'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT 1;" >/dev/null'

if [[ "${deploys_api}" -eq 1 ]]; then
  log "verifying schema is fully migrated"
  "${compose[@]}" exec -T api node migrate.js --check
fi

if [[ "${wrappers_published}" -eq 1 ]]; then
  log "verifying the api serves cxx ${wrapper_version}"
  # shellcheck disable=SC2016 # Expand MYSQL_* inside the mysql container.
  served="$("${compose[@]}" exec -T mysql sh -lc \
    'mysql -N -B -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" -e "SELECT CONCAT(name, \"=\", version) FROM versions WHERE name IN (\"wrapper_version_codex\", \"wrapper_version_claude\")"' \
    2>/dev/null)"
  for name in wrapper_version_codex wrapper_version_claude; do
    grep -qx "${name}=${wrapper_version}" <<<"${served}" \
      || fail "api did not project cxx ${wrapper_version} (${name}); check PUBLIC_BASE_URL and that all four platforms are published"
  done
fi

log "checking auth runner"
"${compose[@]}" exec -T auth-runner python -c \
  'import sys, urllib.request; r=urllib.request.urlopen("http://127.0.0.1:8080/health", timeout=8); sys.exit(0 if r.status == 200 else 1)'

log "checking api health endpoint"
if ! curl -fsS --max-time 15 http://127.0.0.1:8488/healthz >/dev/null; then
  log "host port health failed; trying inside api container"
  "${compose[@]}" exec -T api sh -lc \
    'curl -fsS --max-time 15 http://127.0.0.1:8080/healthz >/dev/null'
fi

log "recent critical log scan"
if "${compose[@]}" logs --since "${deploy_started_at}" api auth-runner mysql \
  | grep -Ei 'migration failed|database not reachable|unhandled|fatal|traceback|uncaught' >/tmp/codex-orchestrator-deploy-log-hits.$$; then
  cat /tmp/codex-orchestrator-deploy-log-hits.$$
  rm -f /tmp/codex-orchestrator-deploy-log-hits.$$
  fail "critical log pattern found after deploy"
fi
rm -f /tmp/codex-orchestrator-deploy-log-hits.$$

if [[ "${cleanup}" -eq 1 ]]; then
  log "pruning unused Docker images"
  docker image prune -f >/dev/null
  docker builder prune -f --filter until=24h >/dev/null
fi

log "deploy complete"
