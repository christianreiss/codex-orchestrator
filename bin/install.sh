#!/usr/bin/env bash
#
# Codex Orchestrator installer — empty Docker host to a working console.
#
# Replaces bin/setup.sh (correct, but it could not provision a database and
# demanded a Go toolchain) and bin/setup-quick.sh (prettier, but it wrote an
# ADMIN_ACCESS_MODE the API rejects and never built any wrapper signing
# material, so its stacks were locked behind /setup forever).
#
# Three properties are load-bearing:
#
#  - **Every step is re-runnable.** Steps record themselves in a state file and
#    skip when their work is already done, and each one re-derives its own
#    preconditions instead of trusting the step before it. An installer that
#    cannot survive being interrupted is not one anybody can recover a
#    half-finished install with.
#  - **Machine-drivable.** `--json` puts one object per step on stdout while the
#    human UI goes to stderr, so an agent and a person can both read the same
#    run. `--non-interactive` never prompts: missing input is one error naming
#    everything that is missing, not a question loop.
#  - **Docker is the only hard dependency** beyond coreutils, openssl and curl.
#    The wrapper matrix still has to be compiled here — each installation bakes
#    its own signing key into the binaries — but it compiles in a container when
#    the host has no Go.
#
# `bin/setup.sh` remains as a shim that execs this script.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ─── presentation ────────────────────────────────────────────────────────────
# Everything human goes to stderr so `--json` stdout stays parseable on its own.

USE_COLOR=0
if [[ -t 2 && -z "${NO_COLOR:-}" && "${TERM:-}" != "dumb" ]]; then USE_COLOR=1; fi

if (( USE_COLOR )); then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_CYAN=$'\033[36m'; C_OFF=$'\033[0m'
  G_OK="✓"; G_FAIL="✗"; G_RUN="▸"; G_TODO="○"; G_SKIP="—"
  B_TL="┌"; B_TR="┐"; B_BL="└"; B_BR="┘"; B_H="─"; B_V="│"
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_BOLD=""; C_CYAN=""; C_OFF=""
  G_OK="OK"; G_FAIL="XX"; G_RUN=">"; G_TODO="."; G_SKIP="-"
  B_TL="+"; B_TR="+"; B_BL="+"; B_BR="+"; B_H="-"; B_V="|"
fi

ui()    { printf '%s\n' "$*" >&2; }
info()  { printf '  %s%s%s %s\n' "$C_DIM" "$G_RUN" "$C_OFF" "$*" >&2; }
good()  { printf '  %s%s%s %s\n' "$C_OK" "$G_OK" "$C_OFF" "$*" >&2; }
warn()  { printf '  %s%s%s %s\n' "$C_WARN" "!" "$C_OFF" "$*" >&2; }
fail()  { printf '  %s%s%s %s\n' "$C_ERR" "$G_FAIL" "$C_OFF" "$*" >&2; }

fatal() {
  fail "$*"
  emit_json "$CURRENT_STEP" "false" "$*"
  exit 1
}

hr() {
  local width=64 line=""
  for ((i = 0; i < width; i++)); do line+="$B_H"; done
  printf '%s\n' "$line" >&2
}

banner() {
  (( JSON_MODE )) && return 0
  ui ""
  ui "${C_CYAN}${C_BOLD}  Codex Orchestrator${C_OFF} ${C_DIM}installer${C_OFF}"
  ui ""
}

step_header() {
  local index="$1" total="$2" title="$3"
  ui ""
  printf '%s%s[%d/%d]%s %s%s%s\n' "$C_BOLD" "$C_CYAN" "$index" "$total" "$C_OFF" "$C_BOLD" "$title" "$C_OFF" >&2
}

# ─── JSON output ─────────────────────────────────────────────────────────────

json_escape() {
  local s="$1" out="" i ch
  for ((i = 0; i < ${#s}; i++)); do
    ch="${s:i:1}"
    case "$ch" in
      '"')  out+='\"' ;;
      '\')  out+='\\' ;;
      $'\n') out+='\n' ;;
      $'\r') out+='\r' ;;
      $'\t') out+='\t' ;;
      *)    out+="$ch" ;;
    esac
  done
  printf '%s' "$out"
}

emit_json() {
  (( JSON_MODE )) || return 0
  local step="$1" ok="$2" detail="$3"
  printf '{"step":"%s","ok":%s,"detail":"%s"}\n' \
    "$(json_escape "$step")" "$ok" "$(json_escape "$detail")"
}

step_done() {
  local detail="$*"
  good "$detail"
  emit_json "$CURRENT_STEP" "true" "$detail"
  mark_step_done "$CURRENT_STEP"
}

step_skipped() {
  local detail="$*"
  printf '  %s%s %s%s\n' "$C_DIM" "$G_SKIP" "$detail" "$C_OFF" >&2
  emit_json "$CURRENT_STEP" "true" "$detail"
}

# ─── options ─────────────────────────────────────────────────────────────────

SUBCOMMAND="install"
JSON_MODE=0
NON_INTERACTIVE=0
DRY_RUN=0
CURRENT_STEP="startup"

ONLY_STEP=""
FROM_STEP=""
declare -a FORCE_STEPS=()

ARG_DATA_ROOT=""
ARG_URL=""
ARG_RUNNER_URL=""
ARG_TLS=""            # acme | file | selfsigned | none
ARG_DOMAIN=""
ARG_ACME_EMAIL=""
ARG_TLS_CERT=""
ARG_TLS_KEY=""
ARG_TLS_SANS=""
ARG_PROXY_CIDRS=""
ARG_ADMIN_NAME=""
ARG_ADMIN_USER=""
ARG_ADMIN_EMAIL=""
ARG_ADMIN_PASS_FILE=""
ARG_DB_PASS_FILE=""
SKIP_OWNER=0
SKIP_PUBLIC_READY=0
SKIP_BUILD=0

ALL_STEPS=(prereqs secrets dataroot urls tls wrappers datatier schema apptier signer owner verify)

usage() {
  cat <<'EOF'
Usage: bin/install.sh [subcommand] [options]

Takes an empty Docker host to a working Codex Orchestrator console: secrets,
data directories, TLS, the wrapper fleet, the database schema, the first owner,
and a verified /readyz. Every step is re-runnable; interrupting it and running
it again resumes.

Subcommands
  install            Run the install (default).
  doctor             Diagnose an existing install; each failure names its fix.
  verify             Re-run the readiness checks only.
  print-env          Print the resolved configuration (secrets masked).

Options
  --json                     One JSON object per step on stdout; the human UI
                             stays on stderr. Pair with --non-interactive.
  --non-interactive          Never prompt. Missing required values produce one
                             error listing all of them.
  --dry-run                  Print what each step would do; change nothing.
  --from STEP                Start at STEP, re-running it and everything after.
  --only STEP                Run exactly one step.
  --force STEP               Re-run STEP even if it is recorded done, and let it
                             replace artifacts it would otherwise refuse to
                             touch. Repeatable.

  --data-root PATH           Where persistent data lives.
  --url URL                  Public HTTPS URL hosts will use (PUBLIC_BASE_URL).
  --runner-url URL           Legacy AUTH_RUNNER_CODEX_BASE_URL; defaults to --url.
  --tls MODE                 acme | file | selfsigned | none.
                             `none` means a reverse proxy you run terminates TLS.
  --domain DOMAIN            Domain for the bundled proxy; defaults from --url.
  --acme-email EMAIL         Contact address for ACME (--tls acme).
  --tls-cert PATH            Certificate to install (--tls file).
  --tls-key PATH             Private key to install (--tls file).
  --tls-sans LIST            Extra SANs for --tls selfsigned.
  --proxy-cidrs LIST         Networks your reverse proxy calls from. Enables
                             TRUST_X_FORWARDED so X-Forwarded-* and any
                             X-MTLS-* headers it sets are believed.

  --admin-name NAME          First owner's display name.
  --admin-user USERNAME      First owner's username.
  --admin-email EMAIL        First owner's email.
  --admin-pass-file PATH     File holding the owner's password (min 12 chars).
                             A file, never a flag value: arguments are visible
                             in the process list.
  --db-pass-file PATH        File holding a chosen MySQL password. Omit and one
                             is generated.
  --skip-owner               Stop before creating the first owner.

  --no-build                 Do not rebuild images.
  --skip-public-ready        Do not require the public URL to answer /readyz.
                             For staged rollouts where DNS is not cut over yet.
  -h, --help                 This text.

Steps, in order
  prereqs secrets dataroot urls tls wrappers datatier schema apptier signer
  owner verify

Examples
  bin/install.sh
  bin/install.sh --json --non-interactive \
      --url https://codex.example.com --tls acme --acme-email ops@example.com \
      --admin-name "Ada" --admin-user ada --admin-email ada@example.com \
      --admin-pass-file /run/secrets/owner-password
  bin/install.sh doctor
  bin/install.sh --from wrappers --force wrappers
EOF
}

die_usage() { printf '%s\n' "$*" >&2; printf 'Run bin/install.sh --help\n' >&2; exit 2; }

need_value() {
  local flag="$1" next="${2-}"
  [[ -n "$next" && "$next" != -* ]] || die_usage "$flag requires a value"
  printf '%s' "$next"
}

parse_args() {
  case "${1-}" in
    install|doctor|verify|print-env) SUBCOMMAND="$1"; shift ;;
  esac

  while (( $# )); do
    case "$1" in
      --json) JSON_MODE=1 ;;
      --non-interactive) NON_INTERACTIVE=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --from) FROM_STEP="$(need_value "$1" "${2-}")"; shift ;;
      --only) ONLY_STEP="$(need_value "$1" "${2-}")"; shift ;;
      --force) FORCE_STEPS+=("$(need_value "$1" "${2-}")"); shift ;;
      --data-root) ARG_DATA_ROOT="$(need_value "$1" "${2-}")"; shift ;;
      --url) ARG_URL="$(need_value "$1" "${2-}")"; shift ;;
      --runner-url) ARG_RUNNER_URL="$(need_value "$1" "${2-}")"; shift ;;
      --tls) ARG_TLS="$(need_value "$1" "${2-}")"; shift ;;
      --domain) ARG_DOMAIN="$(need_value "$1" "${2-}")"; shift ;;
      --acme-email) ARG_ACME_EMAIL="$(need_value "$1" "${2-}")"; shift ;;
      --tls-cert) ARG_TLS_CERT="$(need_value "$1" "${2-}")"; shift ;;
      --tls-key) ARG_TLS_KEY="$(need_value "$1" "${2-}")"; shift ;;
      --tls-sans) ARG_TLS_SANS="$(need_value "$1" "${2-}")"; shift ;;
      --proxy-cidrs) ARG_PROXY_CIDRS="$(need_value "$1" "${2-}")"; shift ;;
      --admin-name) ARG_ADMIN_NAME="$(need_value "$1" "${2-}")"; shift ;;
      --admin-user) ARG_ADMIN_USER="$(need_value "$1" "${2-}")"; shift ;;
      --admin-email) ARG_ADMIN_EMAIL="$(need_value "$1" "${2-}")"; shift ;;
      --admin-pass-file) ARG_ADMIN_PASS_FILE="$(need_value "$1" "${2-}")"; shift ;;
      --db-pass-file) ARG_DB_PASS_FILE="$(need_value "$1" "${2-}")"; shift ;;
      --skip-owner) SKIP_OWNER=1 ;;
      --no-build) SKIP_BUILD=1 ;;
      --skip-public-ready) SKIP_PUBLIC_READY=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die_usage "unknown option: $1" ;;
    esac
    shift
  done

  # A password on the command line is readable by every process on the box.
  [[ -n "$ARG_ADMIN_PASS_FILE" && ! -r "$ARG_ADMIN_PASS_FILE" ]] &&
    die_usage "--admin-pass-file is not readable: $ARG_ADMIN_PASS_FILE"
  [[ -n "$ARG_DB_PASS_FILE" && ! -r "$ARG_DB_PASS_FILE" ]] &&
    die_usage "--db-pass-file is not readable: $ARG_DB_PASS_FILE"

  local step
  for step in ${ONLY_STEP:+$ONLY_STEP} ${FROM_STEP:+$FROM_STEP} ${FORCE_STEPS[@]+"${FORCE_STEPS[@]}"}; do
    known_step "$step" || die_usage "unknown step: $step (see --help)"
  done
  return 0
}

known_step() {
  local candidate="$1" step
  for step in "${ALL_STEPS[@]}"; do [[ "$step" == "$candidate" ]] && return 0; done
  return 1
}

forced() {
  local candidate="$1" step
  for step in ${FORCE_STEPS[@]+"${FORCE_STEPS[@]}"}; do
    [[ "$step" == "$candidate" ]] && return 0
  done
  return 1
}

# ─── prompts ─────────────────────────────────────────────────────────────────
# Collected while running so `--non-interactive` can report every missing value
# at once instead of failing on the first one.

declare -a MISSING_INPUTS=()

ask() {
  local var="$1" question="$2" default_value="${3:-}" override="${4-}"
  if [[ -n "$override" ]]; then printf -v "$var" '%s' "$override"; return 0; fi
  if (( NON_INTERACTIVE )); then
    if [[ -z "$default_value" ]]; then
      MISSING_INPUTS+=("$question")
      printf -v "$var" '%s' ""
      return 0
    fi
    printf -v "$var" '%s' "$default_value"
    return 0
  fi
  local suffix="" answer
  [[ -n "$default_value" ]] && suffix=" [${default_value}]"
  read -rp "$(printf '  %s?%s %s%s ' "$C_CYAN" "$C_OFF" "$question" "$suffix")" answer </dev/tty || answer=""
  printf -v "$var" '%s' "${answer:-$default_value}"
}

ask_yes_no() {
  local question="$1" default_choice="${2:-y}" answer hint
  if (( NON_INTERACTIVE )); then [[ "${default_choice,,}" == "y" ]]; return; fi
  case "${default_choice,,}" in y) hint="[Y/n]" ;; n) hint="[y/N]" ;; *) hint="[y/n]" ;; esac
  while true; do
    read -rp "$(printf '  %s?%s %s %s ' "$C_CYAN" "$C_OFF" "$question" "$hint")" answer </dev/tty || answer="$default_choice"
    answer="${answer:-$default_choice}"
    case "${answer,,}" in y|yes) return 0 ;; n|no) return 1 ;; *) ui "  please answer y or n" ;; esac
  done
}

ask_secret() {
  local var="$1" question="$2" first second
  if (( NON_INTERACTIVE )); then MISSING_INPUTS+=("$question"); printf -v "$var" '%s' ""; return 0; fi
  while true; do
    read -rsp "$(printf '  %s?%s %s ' "$C_CYAN" "$C_OFF" "$question")" first </dev/tty; printf '\n' >&2
    read -rsp "$(printf '  %s?%s confirm: ' "$C_CYAN" "$C_OFF")" second </dev/tty; printf '\n' >&2
    if [[ "$first" != "$second" ]]; then ui "  they do not match"; continue; fi
    if (( ${#first} < 12 )); then ui "  the API requires at least 12 characters"; continue; fi
    printf -v "$var" '%s' "$first"
    return 0
  done
}

require_inputs() {
  (( ${#MISSING_INPUTS[@]} )) || return 0
  fail "missing required values in --non-interactive mode:"
  local item
  for item in "${MISSING_INPUTS[@]}"; do printf '      - %s\n' "$item" >&2; done
  emit_json "$CURRENT_STEP" "false" "missing ${#MISSING_INPUTS[@]} required value(s)"
  exit 2
}

# Keeps `--dry-run` narration honest: "would create" while planning, "created"
# while doing. A dry run that reports past-tense work is worse than no dry run.
say() {
  local hypothetical="$1" verb="$2"
  if (( DRY_RUN )); then printf '%s %s' "$hypothetical" "$verb"
  else printf '%sd' "${verb%e}e"; fi
}

mask() {
  local s="${1-}"
  if (( ${#s} == 0 )); then printf '(empty)'
  elif (( ${#s} <= 8 )); then printf '********'
  else printf '%s…%s' "${s:0:3}" "${s: -3}"; fi
}

# ─── env file ────────────────────────────────────────────────────────────────

ENV_PATH=""

env_get() {
  local key="$1" line
  [[ -f "$ENV_PATH" ]] || return 1
  line="$(LC_ALL=C grep -E "^[[:space:]]*${key}=" "$ENV_PATH" | tail -n 1 || true)"
  [[ -z "$line" ]] && return 1
  local value="${line#*=}"
  # Values written by hand may be quoted; the API's own loader strips matching
  # outer quotes, so this has to agree with it.
  if [[ "$value" == \"*\" || "$value" == \'*\' ]]; then value="${value:1:${#value}-2}"; fi
  printf '%s' "$value"
}

env_set() {
  local key="$1" value="$2" tmp
  (( DRY_RUN )) && { info "would set $key"; return 0; }
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done=0; re="^[ \t]*#?[ \t]*" k "=" }
    $0 ~ re { if (!done) { print k "=" v; done=1; next } }
    { print }
    END { if (!done) print k "=" v }
  ' "$ENV_PATH" > "$tmp"
  mv "$tmp" "$ENV_PATH"
  chmod 600 "$ENV_PATH" 2>/dev/null || true
}

# `.env` holds the database root password, the secretbox key and the runner
# shared secret. The old installer relaxed this to 0644 whenever the `www-data`
# user was absent — which is every Fedora, Arch and RHEL box — so the floor is
# now unconditional and nothing widens it.
lock_env_perms() {
  (( DRY_RUN )) && return 0
  chmod 600 "$ENV_PATH" 2>/dev/null || true
}

random_secret() {
  local length="${1:-24}"
  openssl rand -base64 $((length * 2)) | tr -dc 'A-Za-z0-9' | head -c "$length"
}

generate_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then uuidgen | tr '[:upper:]' '[:lower:]'; return; fi
  if [[ -r /proc/sys/kernel/random/uuid ]]; then cat /proc/sys/kernel/random/uuid; return; fi
  # Last resort: not RFC-4122 shaped, but INSTALLATION_ID is only ever compared
  # for equality, never parsed.
  openssl rand -hex 16
}

# ─── state ───────────────────────────────────────────────────────────────────
# Lives under DATA_ROOT so it survives a checkout being moved or rebuilt, and so
# two data roots on one machine keep separate progress.

STATE_FILE=""

state_path() {
  [[ -n "${DATA_ROOT_RESOLVED:-}" ]] || return 1
  printf '%s/.install-state' "$DATA_ROOT_RESOLVED"
}

mark_step_done() {
  local step="$1"
  (( DRY_RUN )) && return 0
  STATE_FILE="$(state_path 2>/dev/null || true)"
  [[ -n "$STATE_FILE" ]] || return 0
  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || return 0
  grep -qxF "$step" "$STATE_FILE" 2>/dev/null || printf '%s\n' "$step" >> "$STATE_FILE"
}

step_is_done() {
  local step="$1"
  STATE_FILE="$(state_path 2>/dev/null || true)"
  [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]] || return 1
  grep -qxF "$step" "$STATE_FILE" 2>/dev/null
}

# ─── docker ──────────────────────────────────────────────────────────────────

declare -a COMPOSE=()
USE_CADDY=0

# Runs compose with the chosen env file loaded into compose's *own* environment,
# not merely named in `env_file:`.
#
# Two distinct things read that file, and only one of them honours ENV_FILE.
# `env_file:` hands variables to the container — but every key also listed under
# `environment:` shadows it, and those `${VAR:-default}` expressions interpolate
# from compose's environment, which is the shell plus `./.env` and never
# ENV_FILE. So does every `${VAR}` in a bind-mount source. Point ENV_FILE at
# `.env.local` without this and `${AUTH_RUNNER_SHARED_SECRET:-}` resolves to
# empty while the file plainly sets it, or the wrapper matrix publishes to the
# custom DATA_ROOT while the container mounts the default one — a stack that
# builds cleanly and fails verification for no visible reason.
#
# Exporting the whole file closes it for every key at once, which beats
# maintaining a list that silently rots as compose gains variables.
compose() {
  local -a overrides=()

  if [[ -f "${ENV_PATH:-}" ]]; then
    local line key
    while IFS= read -r line; do
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      [[ "$line" =~ ^[[:space:]]*$ ]] && continue
      key="${line%%=*}"; key="${key//[[:space:]]/}"
      [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
      overrides+=("$key=$(env_get "$key")")
    done < "$ENV_PATH"
  fi

  # `env` is last-wins, so these two go after the file's own keys. Both would
  # otherwise be clobbered by it: `.env.example` ships a literal `ENV_FILE=./.env`
  # that would send compose looking for a file this run is not using, and
  # step_dataroot may have just changed DATA_ROOT to something the file predates.
  [[ -n "${DATA_ROOT_RESOLVED:-}" ]] && overrides+=("DATA_ROOT=$DATA_ROOT_RESOLVED")
  [[ -n "${ENV_PATH:-}" ]] && overrides+=("ENV_FILE=$ENV_PATH")

  env "${overrides[@]}" "${COMPOSE[@]}" "$@"
}

compose_profiles() {
  (( USE_CADDY )) && printf '%s' "--profile caddy"
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose -p codex-orchestrator)
    return 0
  fi
  return 1
}

require_cmd() { command -v "$1" >/dev/null 2>&1; }

# ─── readiness ───────────────────────────────────────────────────────────────

API_LOCAL="http://127.0.0.1:8488"

fetch_url() {
  local url="$1" attempts="${2:-1}" ca=() body
  if [[ -n "${DATA_ROOT_RESOLVED:-}" && -f "${DATA_ROOT_RESOLVED}/caddy/tls/ca.crt" && "$url" == https://* ]]; then
    ca=(--cacert "${DATA_ROOT_RESOLVED}/caddy/tls/ca.crt")
  fi
  local i
  for ((i = 1; i <= attempts; i++)); do
    if body="$(curl -fsS --max-time 8 "${ca[@]}" "$url" 2>/dev/null)"; then
      printf '%s' "$body"
      return 0
    fi
    (( i < attempts )) && sleep 2
  done
  return 1
}

# Reads one readiness check out of a /readyz body. The API container already
# ships Node, so no JSON parser is needed on the host — but `doctor` has to work
# when that container is down, so callers must handle a non-zero return rather
# than assuming this can always answer.
readyz_check_ok() {
  local body="$1" id="$2"
  printf '%s' "$body" | compose exec -T -e CHECK_ID="$id" api node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        const checks = JSON.parse(raw).checks ?? [];
        const hit = checks.find((c) => c.id === process.env.CHECK_ID);
        process.exit(hit && hit.ok ? 0 : 1);
      } catch { process.exit(2); }
    });
  ' >/dev/null 2>&1
}

readyz_failures() {
  local body="$1"
  printf '%s' "$body" | compose exec -T api node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        for (const c of JSON.parse(raw).checks ?? []) {
          if (!c.ok) console.log(`${c.id}\t${c.detail ?? ""}`);
        }
      } catch { process.exit(2); }
    });
  ' 2>/dev/null || true
}

# What to do about each failing readiness check. A diagnosis without a next
# command is just a nicer way of saying "broken".
# Whether the one-time first-owner claim has been taken.
#
# `/readyz` does not carry this — it reports infrastructure, and owner state
# lives on `/admin/setup/status`. That endpoint is deliberately public *only*
# while the installation is unclaimed and 401s afterwards, so an unreadable
# response is itself the answer: somebody already owns this install.
owner_exists() {
  local body
  if ! body="$(fetch_url "$API_LOCAL/admin/setup/status" 1)"; then
    return 0
  fi
  ! printf '%s' "$body" | grep -q '"owner_created":false'
}

remedy_for() {
  case "$1" in
    database)        printf 'MySQL is unreachable. `docker compose logs mysql`, then `bin/install.sh --from datatier`.' ;;
    migrations)      printf 'Schema is missing or behind. `bin/install.sh --only schema`.' ;;
    runner)          printf 'Auth runner is down. `docker compose logs auth-runner`; it needs build-time internet access.' ;;
    signer)          printf 'No active wrapper signing key. `bin/install.sh --only signer`.' ;;
    wrappers)        printf 'Wrapper matrix incomplete or signed for another installation. `bin/install.sh --only wrappers --force wrappers`.' ;;
    public_base_url) printf 'PUBLIC_BASE_URL is unset or not a valid http(s) URL. `bin/install.sh --only urls`.' ;;
    *)               printf 'See `docker compose logs api`.' ;;
  esac
}

# ─── steps ───────────────────────────────────────────────────────────────────

DATA_ROOT_RESOLVED=""
WRAPPER_KEY_DIR=""
WRAPPER_PRIVATE_KEY=""
WRAPPER_PUBLIC_KEY=""

step_prereqs() {
  local missing=()
  require_cmd docker || missing+=("docker")
  require_cmd curl || missing+=("curl")
  require_cmd openssl || missing+=("openssl")
  require_cmd awk || missing+=("awk")

  if (( ${#missing[@]} )); then
    fatal "missing required commands: ${missing[*]}"
  fi

  if ! docker info >/dev/null 2>&1; then
    fatal "the Docker daemon is not reachable; start Docker and re-run"
  fi
  if ! detect_compose; then
    fatal "Docker Compose v2 is required (install the compose plugin; the legacy docker-compose binary will not do)"
  fi

  # Go, make and python3 used to be hard requirements here because the wrapper
  # matrix was cross-compiled on the host. It now falls back to a container, so
  # their absence is a performance note, not a failure.
  if require_cmd go && require_cmd make && require_cmd python3; then
    good "host Go toolchain present — wrapper builds will skip the container"
  else
    info "no host Go toolchain — wrapper builds will use a container"
  fi

  step_done "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo present), compose v2"
}

step_secrets() {
  local created=0
  if [[ ! -f "$ENV_PATH" ]]; then
    [[ -f "$ROOT_DIR/.env.example" ]] || fatal "template missing at $ROOT_DIR/.env.example"
    (( DRY_RUN )) || { cp "$ROOT_DIR/.env.example" "$ENV_PATH"; chmod 600 "$ENV_PATH"; }
    created=1
    info "$(say would 'create') $ENV_PATH from .env.example"
  else
    info "using existing $ENV_PATH"
  fi

  # The API refuses to boot without this and nothing generates it at runtime:
  # the container is read-only, so it could not persist a key even if it tried.
  if [[ -z "$(env_get AUTH_ENCRYPTION_KEY || true)" ]]; then
    env_set AUTH_ENCRYPTION_KEY "$(openssl rand -base64 32 | tr -d '\n')"
    info "$(say would 'generate') AUTH_ENCRYPTION_KEY — back this up; canonical auth cannot be decrypted without it"
  fi

  [[ -z "$(env_get INSTALLATION_ID || true)" ]] && env_set INSTALLATION_ID "$(generate_uuid)"

  local db_user db_pass db_root
  db_user="$(env_get DB_USERNAME || true)"
  db_pass="$(env_get DB_PASSWORD || true)"
  db_root="$(env_get DB_ROOT_PASSWORD || true)"
  # The shipped placeholders are only replaced on a file this run created;
  # a value someone deliberately set is never rotated out from under them.
  [[ -z "$db_user" || ( $created == 1 && "$db_user" == "codex" ) ]] &&
    env_set DB_USERNAME "codex$(random_secret 6 | tr '[:upper:]' '[:lower:]')"
  if [[ -n "$ARG_DB_PASS_FILE" ]]; then
    env_set DB_PASSWORD "$(< "$ARG_DB_PASS_FILE")"
  elif [[ -z "$db_pass" || ( $created == 1 && "$db_pass" == "codex-pass" ) ]]; then
    env_set DB_PASSWORD "$(random_secret 24)"
  fi
  [[ -z "$db_root" || ( $created == 1 && "$db_root" == "root-pass" ) ]] &&
    env_set DB_ROOT_PASSWORD "$(random_secret 24)"
  [[ -z "$(env_get DB_DATABASE || true)" ]] && env_set DB_DATABASE codex_auth

  # The API and the runner authenticate to each other with this. Two different
  # values is a stack that builds fine and fails every verification.
  local api_secret runner_secret shared
  api_secret="$(env_get AUTH_RUNNER_SHARED_SECRET || true)"
  runner_secret="$(env_get RUNNER_SHARED_SECRET || true)"
  if [[ -n "$api_secret" && -n "$runner_secret" && "$api_secret" != "$runner_secret" ]]; then
    fatal "AUTH_RUNNER_SHARED_SECRET and RUNNER_SHARED_SECRET differ; make them identical and re-run"
  fi
  shared="${api_secret:-$runner_secret}"
  [[ -z "$shared" ]] && shared="$(random_secret 48)"
  env_set AUTH_RUNNER_SHARED_SECRET "$shared"
  env_set RUNNER_SHARED_SECRET "$shared"

  # `mtls` was a valid value until this server stopped issuing certificates;
  # a stale `.env` carrying it would now fail schema validation at boot.
  local mode
  mode="$(env_get ADMIN_ACCESS_MODE || true)"
  [[ "$mode" == "cookie" || "$mode" == "open" ]] || env_set ADMIN_ACCESS_MODE cookie

  lock_env_perms
  step_done "secrets present, $ENV_PATH mode 0600"
}

step_dataroot() {
  local current default_root="/var/docker_data/codex-auth.example.com" chosen
  current="$(env_get DATA_ROOT || true)"
  [[ -n "$current" ]] && default_root="$current"
  ask chosen "Where should persistent data live?" "$default_root" "$ARG_DATA_ROOT"
  require_inputs
  [[ "$chosen" != /* ]] && chosen="$ROOT_DIR/${chosen#./}"

  if (( ! DRY_RUN )); then
    mkdir -p "$chosen"/{store,store/sql,store/logs,mysql_data,caddy/tls,backups} ||
      fatal "cannot create data directories under $chosen (try sudo, or pick a writable path)"
    # Deliberately not `chmod -R` over the whole store: the wrapper signing key
    # lives under it at mode 0600, and a recursive widen would quietly publish
    # this installation's private key to every local user. Directories only.
    find "$chosen/store" "$chosen/caddy" "$chosen/backups" \
      -type d -not -path "*/wrapper/v2/keys*" -exec chmod 775 {} + 2>/dev/null || true
  fi
  env_set DATA_ROOT "$chosen"
  DATA_ROOT_RESOLVED="$chosen"
  step_done "$chosen"
}

step_urls() {
  local public_url runner_url host default_url
  default_url="$(env_get PUBLIC_BASE_URL || true)"
  [[ -z "$default_url" || "$default_url" == *example.com* ]] && default_url=""
  ask public_url "Public HTTPS URL hosts will use" "$default_url" "$ARG_URL"
  require_inputs
  [[ -n "$public_url" ]] || fatal "a public base URL is required; hosts bake it into their wrapper config"

  public_url="${public_url%/}"
  env_set PUBLIC_BASE_URL "$public_url"
  env_set CODEX_SYNC_BASE_URL "$public_url"

  ask runner_url "URL the auth runner should use" "$public_url" "$ARG_RUNNER_URL"
  env_set AUTH_RUNNER_CODEX_BASE_URL "${runner_url%/}"

  host="${public_url#*://}"; host="${host%%/*}"; host="${host%%:*}"
  [[ -n "$host" ]] && env_set CADDY_DOMAIN "$host"

  # Passkey registration derives its relying-party origin from the request, and
  # enabling proxy trust in the next step changes which host that resolves to.
  # An RP id fixed to something else silently breaks enrollment.
  local rp_id
  rp_id="$(env_get ADMIN_WEBAUTHN_RP_ID || true)"
  if [[ -n "$rp_id" && "$rp_id" != "$host" ]]; then
    warn "ADMIN_WEBAUTHN_RP_ID is '$rp_id' but the public host is '$host' — passkey enrollment will fail until they agree"
  fi

  step_done "$public_url"
}

step_tls() {
  local mode
  if [[ -n "$ARG_TLS" ]]; then
    mode="$ARG_TLS"
  elif (( NON_INTERACTIVE )); then
    mode="none"
  else
    ui ""
    ui "    1) acme        bundled Caddy gets certificates from Let's Encrypt (needs public :80/:443)"
    ui "    2) file        bundled Caddy uses a certificate and key you supply"
    ui "    3) selfsigned  bundled Caddy uses a generated CA — development only"
    ui "    4) none        a reverse proxy you already run terminates TLS"
    local pick
    ask pick "How should HTTPS be terminated? [1-4]" "1"
    case "$pick" in 1) mode=acme ;; 2) mode=file ;; 3) mode=selfsigned ;; 4) mode=none ;; *) mode="$pick" ;; esac
  fi

  local domain tls_dir="${DATA_ROOT_RESOLVED}/caddy/tls"
  domain="$(env_get CADDY_DOMAIN || true)"
  [[ -n "$ARG_DOMAIN" ]] && { domain="$ARG_DOMAIN"; env_set CADDY_DOMAIN "$domain"; }
  env_set CADDY_TLS_DIR "$tls_dir"

  case "$mode" in
    acme)
      USE_CADDY=1
      local email
      ask email "Contact address for ACME" "$(env_get CADDY_ACME_EMAIL || true)" "$ARG_ACME_EMAIL"
      require_inputs
      env_set CADDY_ACME_EMAIL "$email"
      env_set CADDY_TLS_FRAGMENT /etc/caddy/tls-acme.caddy
      info "ACME needs :80 and :443 on $domain to reach this host"
      ;;
    file)
      USE_CADDY=1
      [[ -n "$ARG_TLS_CERT" && -n "$ARG_TLS_KEY" ]] || {
        ask ARG_TLS_CERT "Path to the certificate" "" "$ARG_TLS_CERT"
        ask ARG_TLS_KEY "Path to the private key" "" "$ARG_TLS_KEY"
        require_inputs
      }
      [[ -r "$ARG_TLS_CERT" ]] || fatal "certificate not readable: $ARG_TLS_CERT"
      [[ -r "$ARG_TLS_KEY" ]] || fatal "private key not readable: $ARG_TLS_KEY"
      if (( ! DRY_RUN )); then
        install -m 644 "$ARG_TLS_CERT" "$tls_dir/tls.crt"
        install -m 600 "$ARG_TLS_KEY" "$tls_dir/tls.key"
      fi
      env_set CADDY_TLS_FRAGMENT /etc/caddy/tls-custom.caddy
      env_set CADDY_TLS_CERT_FILE /etc/caddy/tls/tls.crt
      env_set CADDY_TLS_KEY_FILE /etc/caddy/tls/tls.key
      ;;
    selfsigned)
      USE_CADDY=1
      if (( ! DRY_RUN )); then generate_self_signed "$tls_dir" "$domain"; fi
      env_set CADDY_TLS_FRAGMENT /etc/caddy/tls-custom.caddy
      env_set CADDY_TLS_CERT_FILE /etc/caddy/tls/server.crt
      env_set CADDY_TLS_KEY_FILE /etc/caddy/tls/server.key
      warn "self-signed: trust $tls_dir/ca.crt on every client, or hosts will refuse to sync"
      ;;
    none)
      USE_CADDY=0
      info "bundled proxy disabled; the API listens on 127.0.0.1:8488 for your proxy"
      ;;
    *) fatal "unknown TLS mode: $mode (expected acme, file, selfsigned or none)" ;;
  esac

  configure_proxy_trust "$mode"
  step_done "TLS mode: $mode"
}

# `X-Forwarded-*` and the `X-MTLS-*` claims a proxy that terminates mTLS may
# forward are only believable from the proxy itself — a direct caller can type
# the same bytes. Both are gated on this allowlist, and both stay off until it
# is set, which is why the bundled-proxy path fills it in automatically.
configure_proxy_trust() {
  local mode="$1" cidrs=""
  if [[ -n "$ARG_PROXY_CIDRS" ]]; then
    cidrs="$ARG_PROXY_CIDRS"
  elif [[ "$mode" != "none" ]]; then
    cidrs="$(env_get CODEX_AUTH_SUBNET || true)"
    [[ -z "$cidrs" ]] && cidrs="172.30.250.0/24"
  elif (( ! NON_INTERACTIVE )); then
    local existing
    existing="$(env_get TRUSTED_PROXY_CIDRS || true)"
    ask cidrs "Networks your reverse proxy calls from (blank to trust no forwarded headers)" "$existing"
  fi

  if [[ -n "$cidrs" ]]; then
    env_set TRUST_X_FORWARDED 1
    env_set TRUSTED_PROXY_CIDRS "$cidrs"
    info "trusting forwarded headers from $cidrs"
  else
    env_set TRUST_X_FORWARDED 0
    env_set TRUSTED_PROXY_CIDRS ""
    warn "no trusted proxy networks: X-Forwarded-* and X-MTLS-* headers will be ignored, and client IPs will read as the proxy's"
  fi
}

generate_self_signed() {
  local dir="$1" cn="$2"
  mkdir -p "$dir"
  if [[ -f "$dir/server.crt" && -f "$dir/server.key" ]] && ! forced tls; then
    info "reusing the existing self-signed certificate (--force tls to regenerate)"
    return 0
  fi
  openssl req -x509 -new -nodes -sha256 -days 3650 -subj "/CN=${cn} Local CA" \
    -newkey rsa:4096 -keyout "$dir/ca.key" -out "$dir/ca.crt" >/dev/null 2>&1
  chmod 600 "$dir/ca.key"

  local sans="${ARG_TLS_SANS:-localhost,127.0.0.1}" lines=() idx=1 entry
  IFS=',' read -ra entries <<<"$sans"
  for entry in "${entries[@]}"; do
    entry="$(printf '%s' "$entry" | tr -d '[:space:]')"
    [[ -z "$entry" ]] && continue
    if [[ "$entry" =~ ^[0-9.]+$ ]]; then lines+=("IP.$idx = $entry"); else lines+=("DNS.$idx = $entry"); fi
    idx=$((idx + 1))
  done
  lines+=("DNS.$idx = $cn")

  cat > "$dir/server.ext" <<EOF
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$(printf '%s\n' "${lines[@]}")
EOF

  openssl req -new -nodes -newkey rsa:4096 -keyout "$dir/server.key" -subj "/CN=${cn}" -out "$dir/server.csr" >/dev/null 2>&1
  openssl x509 -req -in "$dir/server.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -CAcreateserial \
    -out "$dir/server.crt" -days 825 -sha256 -extfile "$dir/server.ext" -extensions v3_req >/dev/null 2>&1
  rm -f "$dir/server.csr" "$dir/server.ext"
  chmod 600 "$dir/server.key"
}

# Steps reachable via `--only` cannot assume `step_dataroot` ran in this
# invocation. Without this, an unresolved data root silently becomes `/` and the
# step tries to write to `/store`.
require_data_root() {
  [[ -n "${DATA_ROOT_RESOLVED:-}" ]] ||
    fatal "no data root resolved. Pass --data-root, or run the full install once so it is recorded in $ENV_PATH."
}

wrapper_key_paths() {
  require_data_root
  WRAPPER_KEY_DIR="$DATA_ROOT_RESOLVED/store/wrapper/v2/keys"
  WRAPPER_PRIVATE_KEY="$WRAPPER_KEY_DIR/installation-signing.ed25519"
  WRAPPER_PUBLIC_KEY="$WRAPPER_KEY_DIR/installation-signing.ed25519.pub"
}

# Splitting on `=` and trimming, rather than counting fields around `?=`: the
# inherited version indexed a field that only exists with one exact spelling of
# the assignment, so `VERSION ?= 0.7.7` yielded nothing and the build died
# claiming the Makefile had no VERSION at all.
wrapper_version() {
  awk -F'=' '
    /^VERSION[[:space:]]*\?=/ {
      sub(/^[[:space:]]+/, "", $2); sub(/[[:space:]]+$/, "", $2)
      print $2; exit
    }' "$ROOT_DIR/wrappers/Makefile"
}

step_wrappers() {
  wrapper_key_paths
  (( DRY_RUN )) && { info "would build the four-platform cxx matrix"; step_skipped "dry run"; return 0; }
  mkdir -p "$WRAPPER_KEY_DIR"; chmod 700 "$WRAPPER_KEY_DIR" 2>/dev/null || true

  # Each installation signs its own wrapper binaries, so the keypair has to
  # exist before anything is compiled — the public key is baked into the build.
  if [[ -f "$WRAPPER_PRIVATE_KEY" && ! -f "$WRAPPER_PUBLIC_KEY" ]]; then
    fatal "private wrapper key exists without its public key in $WRAPPER_KEY_DIR; restore the pair before re-running"
  fi
  if [[ ! -f "$WRAPPER_PUBLIC_KEY" ]]; then
    openssl genpkey -algorithm Ed25519 -outform PEM -out "$WRAPPER_PRIVATE_KEY"
    openssl pkey -in "$WRAPPER_PRIVATE_KEY" -pubout -outform PEM -out "$WRAPPER_PUBLIC_KEY"
    chmod 600 "$WRAPPER_PRIVATE_KEY"; chmod 644 "$WRAPPER_PUBLIC_KEY"
    info "generated this installation's wrapper signing keypair"
  elif [[ -f "$WRAPPER_PRIVATE_KEY" ]]; then
    local derived existing
    derived="$(openssl pkey -in "$WRAPPER_PRIVATE_KEY" -pubout -outform DER | openssl base64 -A)"
    existing="$(openssl pkey -pubin -in "$WRAPPER_PUBLIC_KEY" -outform DER | openssl base64 -A)"
    [[ "$derived" == "$existing" ]] || fatal "wrapper private and public keys do not match in $WRAPPER_KEY_DIR"
  fi

  local version publish_root present=0 complete=1 key_b64 platform manifest binary
  version="$(wrapper_version)"
  [[ -n "$version" ]] || fatal "could not read VERSION from wrappers/Makefile"
  publish_root="$DATA_ROOT_RESOLVED/store/wrapper/v2/bin"
  key_b64="$(base64 -w0 "$WRAPPER_PUBLIC_KEY" 2>/dev/null || base64 "$WRAPPER_PUBLIC_KEY" | tr -d '\n')"

  for platform in linux-amd64 linux-arm64 darwin-amd64 darwin-arm64; do
    manifest="$publish_root/cxx/$platform/manifest.json"
    binary="$publish_root/cxx/$platform/v${version}/cxx"
    [[ -e "$manifest" || -e "$binary" ]] && present=1
    if [[ ! -f "$manifest" || ! -x "$binary" ]]; then complete=0; continue; fi
    grep -q "\"current\"[[:space:]]*:[[:space:]]*\"${version}\"" "$manifest" || complete=0
    grep -aFq "$key_b64" "$binary" || grep -aFq "$(cat "$WRAPPER_PUBLIC_KEY")" "$binary" || complete=0
  done

  if (( complete )); then
    publish_readable "$publish_root"
    step_done "four platforms present at v$version, signed by this installation"
    return 0
  fi

  # Establish that a rebuild is actually possible BEFORE touching anything.
  #
  # `step_signer` deletes the plaintext private key once the database holds an
  # encrypted copy, which is correct and also means the matrix stops being
  # rebuildable in place from that moment on. Replacing the signing key is a
  # coupled fleet operation — every deployed binary embeds one public key — so
  # it belongs to the documented rotation runbook, not to a `--force` flag.
  if [[ ! -f "$WRAPPER_PRIVATE_KEY" ]]; then
    fatal "the wrapper matrix under $publish_root is incomplete, but this installation's plaintext signing key is gone (it was imported into the database and removed, as intended). Restore $WRAPPER_PRIVATE_KEY from backup to rebuild in place, or follow the key-rotation runbook in docs/wrapper-v2-architecture.md — rotating without rolling the fleet in the same window takes every host offline."
  fi

  # Half a matrix is worse than none: hosts would download a binary this
  # installation cannot sign for. Refusing is right, but the previous installer
  # left no way forward at all, so one partial state bricked every re-run.
  if (( present )) && ! forced wrappers; then
    fatal "wrapper artifacts under $publish_root are incomplete, mixed, or signed for another installation. Re-run with --force wrappers to set them aside and rebuild, or restore the matching matrix."
  fi
  if (( present )); then
    local backup="$publish_root.superseded.$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$publish_root" "$backup"
    warn "moved the previous matrix to $backup"
  fi

  local stage; stage="$(mktemp -d)"
  build_wrapper_matrix "$version" "$stage" "$publish_root"
  rm -rf "$stage"
  publish_readable "$publish_root"
  step_done "built and published cxx v$version for four platforms"
}

# `publish-release.py` creates each version directory at mode 0700, which the API
# cannot read: the service drops every capability, so container-root has no
# CAP_DAC_OVERRIDE and cannot traverse a directory owned by the installing user.
# The symptom is a `wrappers` readiness check reporting "artifact missing or
# checksum mismatch" for a file that plainly exists on the host.
#
# `a+rX` adds read everywhere and traverse on directories only, leaving the
# binary's own execute bit alone. Scoped to the published store on purpose: the
# signing keys are a sibling directory at 0700/0600 and must stay that way. The
# previous installer widened the whole store tree with a recursive `chmod 775`,
# which fixed this by accident and published the private signing key along with
# it.
publish_readable() {
  chmod -R a+rX "$1" 2>/dev/null || true
}

# Host toolchain when it exists, container otherwise. The container path is what
# lets the README's "all you need is Docker" claim be true.
build_wrapper_matrix() {
  local version="$1" stage="$2" publish_root="$3" commit
  commit="$(git -C "$ROOT_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"

  if require_cmd go && require_cmd make && require_cmd python3; then
    info "building on the host toolchain"
    make -C wrappers release VERSION="$version" COMMIT="$commit" \
      OUTROOT="$stage" PUBLIC_KEY_FILE="$WRAPPER_PUBLIC_KEY" >&2
    make -C wrappers publish-release VERSION="$version" \
      OUTROOT="$stage" PUBLISH_ROOT="$publish_root" >&2
    return 0
  fi

  info "building in a container (no host Go toolchain)"
  # Create the publish root before mounting it. Docker creates a missing
  # bind-mount source itself, as root — and the build runs as the invoking user,
  # which then cannot write into its own output directory.
  mkdir -p "$publish_root" || fatal "cannot create $publish_root"

  local image="codex-orchestrator/wrapper-build:$version"
  docker build -q -f "$ROOT_DIR/wrappers/Dockerfile.build" -t "$image" "$ROOT_DIR/wrappers" >&2 ||
    fatal "could not build the wrapper toolchain image"

  # Four separate mounts because the inputs genuinely live in four places: the
  # source tree, a staging temp dir, the published store, and the signing key —
  # which sits under DATA_ROOT, *outside* the repo. Mounting the key directory
  # explicitly rather than rewriting its path into /src matters: a path that
  # does not resolve makes the Makefile's `base64` fail silently, and the build
  # falls back to the tracked CI public key. That produces four binaries that
  # look fine and trust the wrong installation.
  #
  # Running as the invoking user keeps the published binaries owned by whoever
  # ran the installer instead of root.
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    -v "$ROOT_DIR:/src" \
    -v "$stage:/stage" \
    -v "$publish_root:/publish" \
    -v "$WRAPPER_KEY_DIR:/keys:ro" \
    -w /src/wrappers \
    "$image" \
    make release publish-release \
      VERSION="$version" COMMIT="$commit" \
      OUTROOT=/stage PUBLISH_ROOT=/publish \
      PUBLIC_KEY_FILE="/keys/$(basename "$WRAPPER_PUBLIC_KEY")" >&2 ||
    fatal "wrapper build failed inside the container"
}

step_datatier() {
  (( DRY_RUN )) && { step_skipped "would start mysql and auth-runner"; return 0; }
  if (( ! SKIP_BUILD )); then
    info "building images"
    compose $(compose_profiles) build --pull >&2 || fatal "image build failed"
  fi
  # MySQL and the runner come up before the API, because the API fails closed on
  # a pending migration and the schema does not exist yet. Starting all three at
  # once is what made the old installer crash-loop on a fresh database.
  info "starting mysql and auth-runner"
  local up=(up -d)
  compose up --help 2>/dev/null | grep -q -- '--wait' && up+=(--wait --wait-timeout 180)
  compose "${up[@]}" mysql auth-runner >&2 || fatal "mysql or auth-runner did not become healthy; check \`docker compose logs\`"
  step_done "mysql and auth-runner healthy"
}

step_schema() {
  (( DRY_RUN )) && { step_skipped "would run migrate.js --init-schema"; return 0; }
  info "provisioning the schema"
  # Creates the baseline only when the database has no application tables, then
  # migrates on top. Safe on every re-run and against an existing installation.
  local output
  if ! output="$(compose run --rm -T api node migrate.js --init-schema 2>&1)"; then
    printf '%s\n' "$output" >&2
    fatal "schema provisioning failed"
  fi
  printf '%s\n' "$output" | sed 's/^/      /' >&2
  step_done "schema present and migrations applied"
}

step_apptier() {
  (( DRY_RUN )) && { step_skipped "would start api and caddy"; return 0; }
  local services=(api) up=(up -d)
  (( USE_CADDY )) && services+=(caddy)
  compose up --help 2>/dev/null | grep -q -- '--wait' && up+=(--wait --wait-timeout 180)
  info "starting ${services[*]}"
  compose $(compose_profiles) "${up[@]}" "${services[@]}" >&2 ||
    fatal "the API did not become healthy; check \`docker compose logs api\`"
  # A missing provider credential is onboarding state, not a broken stack, so
  # the quota worker is never waited on.
  compose $(compose_profiles) up -d quota-cron >&2 || true
  step_done "api healthy"
}

step_signer() {
  wrapper_key_paths
  (( DRY_RUN )) && { step_skipped "would import the signing key"; return 0; }
  if [[ -f "$WRAPPER_PRIVATE_KEY" ]]; then
    info "importing the signing key into encrypted database storage"
    # As the invoking user, not the image's root. The key is mode 0600 and owned
    # by whoever ran the installer, and the api service drops every capability —
    # so container-root has no CAP_DAC_OVERRIDE and cannot read it. The
    # alternative, widening the key so root can read it, hands this
    # installation's signing identity to every local account.
    compose run --rm -T --user "$(id -u):$(id -g)" api node setup-signing-key.js \
      /app/storage/wrapper/v2/keys/installation-signing.ed25519 \
      /app/storage/wrapper/v2/keys/installation-signing.ed25519.pub >&2 ||
      fatal "signing-key import failed"
    # Only after encrypted read-back and a signature round-trip succeeded.
    rm -f -- "$WRAPPER_PRIVATE_KEY"
    step_done "signing key imported; plaintext copy removed"
  else
    step_done "signing key already imported"
  fi
}

step_owner() {
  if (( SKIP_OWNER )); then step_skipped "skipped (--skip-owner)"; return 0; fi
  (( DRY_RUN )) && { step_skipped "would create the first owner"; return 0; }

  local status
  status="$(fetch_url "$API_LOCAL/readyz" 30 || true)"
  [[ -n "$status" ]] || fatal "the API is not answering on $API_LOCAL; run \`bin/install.sh --only apptier\` first"

  # The claim is open only while no admin exists, and it closes permanently on
  # the first success.
  if owner_exists; then
    step_done "an owner already exists"
    return 0
  fi

  local name username email password
  ask name "Owner's full name" "" "$ARG_ADMIN_NAME"
  ask username "Owner's username" "" "$ARG_ADMIN_USER"
  ask email "Owner's email" "" "$ARG_ADMIN_EMAIL"
  if [[ -n "$ARG_ADMIN_PASS_FILE" ]]; then
    password="$(< "$ARG_ADMIN_PASS_FILE")"
    password="${password%$'\n'}"
  else
    ask_secret password "Owner's password (min 12 characters)"
  fi
  require_inputs
  (( ${#password} >= 12 )) || fatal "the API requires an admin password of at least 12 characters"

  # The body goes in on stdin: a password in argv is readable from the process
  # list by every user on the box.
  local body response
  body="$(printf '{"name":"%s","username":"%s","email":"%s","password":"%s"}' \
    "$(json_escape "$name")" "$(json_escape "$username")" \
    "$(json_escape "$email")" "$(json_escape "$password")")"
  response="$(printf '%s' "$body" | curl -sS -o /dev/null -w '%{http_code}' \
    -X POST "$API_LOCAL/admin/setup/owner" \
    -H 'Content-Type: application/json' --data-binary @- 2>/dev/null || true)"
  password=""; body=""

  [[ "$response" == "200" ]] || fatal "owner creation failed (HTTP ${response:-no response}); see \`docker compose logs api\`"
  step_done "owner '$username' created"
}

step_verify() {
  (( DRY_RUN )) && { step_skipped "would verify readiness"; return 0; }
  run_checks
}

# ─── verification ────────────────────────────────────────────────────────────

run_checks() {
  local failed=0 public_url ready health
  public_url="$(env_get PUBLIC_BASE_URL || true)"

  health="$(fetch_url "$API_LOCAL/healthz" 30 || true)"
  if [[ -n "$health" ]]; then good "API liveness"; else fail "API liveness — the container is not answering"; failed=1; fi

  ready="$(fetch_url "$API_LOCAL/readyz" 30 || true)"
  if [[ -z "$ready" ]]; then
    fail "readiness — /readyz did not answer; \`docker compose logs api\`"
    failed=1
  else
    local id detail line
    if [[ -n "$(readyz_failures "$ready")" ]]; then
      while IFS=$'\t' read -r id detail; do
        [[ -z "$id" ]] && continue
        fail "$id — ${detail:-failing}"
        printf '        fix: %s\n' "$(remedy_for "$id")" >&2
        failed=1
      done < <(readyz_failures "$ready")
    else
      good "all critical readiness checks"
    fi
    if ! owner_exists; then
      warn "no owner yet — the console will hold at /admin/setup until one exists"
    fi
  fi

  if (( SKIP_PUBLIC_READY )); then
    info "public readiness bypassed (--skip-public-ready)"
  elif [[ -n "$public_url" ]]; then
    if [[ -n "$(fetch_url "${public_url%/}/readyz" 30 || true)" ]]; then
      good "public readiness at $public_url"
    else
      fail "public readiness — $public_url/readyz did not answer (DNS, firewall, or proxy)"
      failed=1
    fi
  fi

  if (( failed )); then
    ui ""
    printf '%s%sINCOMPLETE%s\n' "$C_ERR" "$C_BOLD" "$C_OFF" >&2
    emit_json "verify" "false" "one or more checks failed"
    return 1
  fi

  ui ""
  printf '%s%sREADY%s  %s/admin\n' "$C_OK" "$C_BOLD" "$C_OFF" "${public_url%/}" >&2
  emit_json "verify" "true" "ready at ${public_url%/}/admin"
  return 0
}

# ─── doctor ──────────────────────────────────────────────────────────────────

cmd_doctor() {
  banner
  ui "  Diagnosis"
  hr
  local failed=0

  if docker info >/dev/null 2>&1; then good "docker daemon"; else fail "docker daemon unreachable — start Docker"; failed=1; fi
  if detect_compose; then good "compose v2"; else fail "compose v2 missing — install the Docker Compose plugin"; failed=1; fi
  if [[ -f "$ENV_PATH" ]]; then
    good "env file $ENV_PATH"
    local perms; perms="$(stat -c '%a' "$ENV_PATH" 2>/dev/null || echo '?')"
    [[ "$perms" == "600" ]] || warn "$ENV_PATH is mode $perms; it holds the database root password and the secretbox key"
  else
    fail "no env file at $ENV_PATH — run \`bin/install.sh\`"
    failed=1
  fi

  DATA_ROOT_RESOLVED="$(env_get DATA_ROOT || true)"
  if [[ -n "$DATA_ROOT_RESOLVED" && -d "$DATA_ROOT_RESOLVED" ]]; then
    good "data root $DATA_ROOT_RESOLVED"
  else
    fail "data root missing or unset — run \`bin/install.sh --only dataroot\`"
    failed=1
  fi

  [[ -z "$(env_get AUTH_ENCRYPTION_KEY || true)" ]] &&
    { fail "AUTH_ENCRYPTION_KEY is unset — the API cannot boot; \`bin/install.sh --only secrets\`"; failed=1; }

  # Everything above works with the stack down. Everything below needs the API,
  # and being down is exactly when someone runs doctor — so a missing API is one
  # clear line, not a crash inside `compose exec`.
  local ready
  ready="$(fetch_url "$API_LOCAL/readyz" 1 || true)"
  if [[ -z "$ready" ]]; then
    fail "API unreachable on $API_LOCAL — \`docker compose ps\` and \`docker compose logs api\`"
    ui ""
    printf '%s%sINCOMPLETE%s\n' "$C_ERR" "$C_BOLD" "$C_OFF" >&2
    return 1
  fi

  local id detail
  if [[ -n "$(readyz_failures "$ready")" ]]; then
    while IFS=$'\t' read -r id detail; do
      [[ -z "$id" ]] && continue
      fail "$id — ${detail:-failing}"
      printf '        fix: %s\n' "$(remedy_for "$id")" >&2
      failed=1
    done < <(readyz_failures "$ready")
  else
    good "all critical readiness checks"
  fi

  # The container's /app/storage is a bind mount whose source compose
  # interpolates from its own environment. If that resolves somewhere other than
  # the data root the wrapper matrix was published into, the `wrappers` check
  # fails with nothing visibly wrong — so name the mismatch directly.
  local mounted
  mounted="$(compose exec -T api sh -c 'ls /app/storage/wrapper/v2/bin/cxx 2>/dev/null | tr "\n" " "' 2>/dev/null || true)"
  if [[ -z "${mounted// /}" ]]; then
    fail "the container sees no wrapper artifacts under /app/storage"
    printf '        fix: the DATA_ROOT compose interpolates does not match %s. Check the shell env and ./.env, not just ENV_FILE.\n' "$DATA_ROOT_RESOLVED" >&2
    failed=1
  else
    good "container storage maps to the published matrix (${mounted% })"
  fi

  owner_exists ||
    warn "no owner — visit /admin/setup or run \`bin/install.sh --only owner\`"

  ui ""
  if (( failed )); then
    printf '%s%sINCOMPLETE%s\n' "$C_ERR" "$C_BOLD" "$C_OFF" >&2
    return 1
  fi
  printf '%s%sHEALTHY%s\n' "$C_OK" "$C_BOLD" "$C_OFF" >&2
  return 0
}

cmd_print_env() {
  [[ -f "$ENV_PATH" ]] || { printf 'no env file at %s\n' "$ENV_PATH" >&2; exit 1; }
  local key
  for key in APP_ENV PUBLIC_BASE_URL CODEX_SYNC_BASE_URL DATA_ROOT CADDY_DOMAIN \
             CADDY_TLS_FRAGMENT ADMIN_ACCESS_MODE TRUST_X_FORWARDED \
             TRUSTED_PROXY_CIDRS DB_DATABASE DB_USERNAME INSTALLATION_ID; do
    printf '%-24s %s\n' "$key" "$(env_get "$key" || printf '(unset)')"
  done
  for key in DB_PASSWORD DB_ROOT_PASSWORD AUTH_ENCRYPTION_KEY AUTH_RUNNER_SHARED_SECRET; do
    printf '%-24s %s\n' "$key" "$(mask "$(env_get "$key" || true)")"
  done
}

# ─── driver ──────────────────────────────────────────────────────────────────

should_run() {
  local step="$1"
  [[ -n "$ONLY_STEP" ]] && { [[ "$step" == "$ONLY_STEP" ]]; return; }
  if [[ -n "$FROM_STEP" ]]; then
    local seen=0 candidate
    for candidate in "${ALL_STEPS[@]}"; do
      [[ "$candidate" == "$FROM_STEP" ]] && seen=1
      [[ "$candidate" == "$step" ]] && { (( seen )); return; }
    done
    return 1
  fi
  return 0
}

step_title() {
  case "$1" in
    prereqs)  printf 'Prerequisites' ;;
    secrets)  printf 'Configuration and secrets' ;;
    dataroot) printf 'Data root' ;;
    urls)     printf 'Public URL' ;;
    tls)      printf 'TLS' ;;
    wrappers) printf 'Wrapper fleet' ;;
    datatier) printf 'Database and auth runner' ;;
    schema)   printf 'Schema' ;;
    apptier)  printf 'API' ;;
    signer)   printf 'Signing key' ;;
    owner)    printf 'First owner' ;;
    verify)   printf 'Verification' ;;
  esac
}

cmd_install() {
  banner
  local total="${#ALL_STEPS[@]}" index=0 step

  # Steps 1-5 write configuration and re-derive their own state cheaply, so they
  # always run: they are how a re-run picks up a changed URL or TLS choice.
  # Later steps do expensive or destructive work and honour the state file.
  for step in "${ALL_STEPS[@]}"; do
    # `index=$((…))`, never `((index++))`: post-increment evaluates to the old
    # value, so the first one returns 0 and `set -e` kills the run.
    index=$((index + 1))
    CURRENT_STEP="$step"
    should_run "$step" || continue

    if step_is_done "$step" && ! forced "$step" && [[ -z "$ONLY_STEP" && -z "$FROM_STEP" ]]; then
      case "$step" in
        wrappers|schema|signer|owner)
          step_header "$index" "$total" "$(step_title "$step")"
          step_skipped "already done (--force $step to repeat)"
          continue
          ;;
      esac
    fi

    step_header "$index" "$total" "$(step_title "$step")"
    "step_${step}"
  done

  if (( DRY_RUN )); then
    ui ""
    ui "  dry run: nothing was changed"
    return 0
  fi

  ui ""
  hr
  ui "  Next, at ${C_BOLD}$(env_get PUBLIC_BASE_URL || printf 'your base URL')/admin${C_OFF}:"
  ui "    · seed canonical Codex and/or Claude credentials"
  ui "    · register your first host and run its installer command"
  ui "  Both are tracked on the dashboard until done; neither blocks the console."
  hr
}

main() {
  parse_args "$@"

  ENV_PATH="${ENV_FILE:-$ROOT_DIR/.env}"
  [[ "$ENV_PATH" != /* ]] && ENV_PATH="$ROOT_DIR/${ENV_PATH#./}"

  detect_compose || true
  # `--only`/`--from` can skip step_dataroot entirely, so seed the resolved root
  # from the env file and fall back to the flag. Leaving it empty makes every
  # path below it resolve against `/`.
  DATA_ROOT_RESOLVED="$(env_get DATA_ROOT 2>/dev/null || true)"
  if [[ -z "$DATA_ROOT_RESOLVED" && -n "$ARG_DATA_ROOT" ]]; then
    DATA_ROOT_RESOLVED="$ARG_DATA_ROOT"
    [[ "$DATA_ROOT_RESOLVED" != /* ]] && DATA_ROOT_RESOLVED="$ROOT_DIR/${DATA_ROOT_RESOLVED#./}"
  fi

  case "$SUBCOMMAND" in
    install)   cmd_install ;;
    doctor)    cmd_doctor ;;
    verify)    banner; run_checks ;;
    print-env) cmd_print_env ;;
  esac
}

main "$@"
