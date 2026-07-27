#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/.." && pwd)"

backup=0
cleanup=1
pull_rebase=0
skip_git=0
no_wait=0
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
  -h, --help           Show this help.

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
deploys_api=1
if [[ "${#services[@]}" -gt 0 ]]; then
  deploys_api=0
  for service in "${services[@]}"; do
    [[ "${service}" == "api" ]] && deploys_api=1
  done
fi

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
