#!/usr/bin/env bash
# Shared by the local instance CLI, installer and deployment helper.
# This file is sourced; env files are data, never shell programs.

instance_env_get() {
  local wanted="$1" line key value found=0 result=""
  [[ -f "$ENV_PATH" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    [[ "$line" == *=* ]] || continue
    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    key="${key#export }"
    [[ "$key" == "$wanted" ]] || continue
    value="${line#*=}"
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then
      value="${value:1:${#value}-2}"
    else
      value="${value%%[[:space:]]#*}"
      value="${value%"${value##*[![:space:]]}"}"
    fi
    result="$value"; found=1
  done < "$ENV_PATH"
  (( found )) || return 1
  printf '%s' "$result"
}

instance_env_path() {
  ENV_PATH="${ENV_FILE:-$INSTANCE_ROOT/.env}"
  [[ "$ENV_PATH" == /* ]] || ENV_PATH="$INSTANCE_ROOT/${ENV_PATH#./}"
}

# File values override the shell, matching the installer. Explicit paths and
# the current install step's data-root override go last. Reload on every call:
# setup can change secrets, TLS and DATA_ROOT between two compose commands.
instance_compose_init() {
  local line key value profile configured
  local -a overrides=() enabled=()
  if [[ -f "$ENV_PATH" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      [[ "$line" == *=* ]] || continue
      key="${line%%=*}"
      key="${key#"${key%%[![:space:]]*}"}"
      key="${key%"${key##*[![:space:]]}"}"
      key="${key#export }"
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      value="$(instance_env_get "$key")"
      overrides+=("$key=$value")
    done < "$ENV_PATH"
  fi
  [[ -z "${DATA_ROOT_RESOLVED:-}" ]] || overrides+=("DATA_ROOT=$DATA_ROOT_RESOLVED")
  overrides+=("ENV_FILE=$ENV_PATH")
  configured="$(instance_env_get COMPOSE_PROFILES || printf '%s' "${COMPOSE_PROFILES:-}")"
  IFS=',' read -r -a enabled <<< "$configured"
  INSTANCE_COMPOSE=(env "${overrides[@]}" docker compose
    --project-directory "$INSTANCE_ROOT" -f "$INSTANCE_ROOT/docker-compose.yml"
    -p codex-orchestrator)
  [[ ! -f "$ENV_PATH" ]] || INSTANCE_COMPOSE+=(--env-file "$ENV_PATH")
  for profile in "${enabled[@]}" "${INSTANCE_PROFILES[@]}"; do
    [[ -z "$profile" ]] || INSTANCE_COMPOSE+=(--profile "$profile")
  done
}

instance_compose() {
  instance_compose_init
  "${INSTANCE_COMPOSE[@]}" "$@"
}

# Old setups did not persist their Caddy choice. Existing containers are proof
# of that choice; the placeholder domain/cert entries in .env are not.
instance_adopt_caddy() {
  local container
  # A recorded choice (including an empty value) wins over old containers.
  # Otherwise switching setup to an external proxy would re-enable Caddy.
  if instance_env_get COMPOSE_PROFILES >/dev/null; then return 0; fi
  container="$(instance_compose --profile '*' ps --all -q caddy)" || return 1
  [[ -z "$container" ]] || INSTANCE_PROFILES+=(caddy)
}
