#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# ── Global state ──────────────────────────────────────────────────────────────

NON_INTERACTIVE=0
BUILD_IMAGES=1
START_STACK=1
DATA_ROOT_ARG=""
URL_ARG=""
ADMIN_NAME_ARG=""
ADMIN_USER_ARG=""
ADMIN_EMAIL_ARG=""
ADMIN_PASS_ARG=""

ADMIN_NAME=""
ADMIN_USERNAME=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""

SPINNER_PID=""
SPINNER_MSG=""
ENV_FILE=""
DATA_ROOT_SELECTED=""
PUBLIC_URL=""

TOTAL_STEPS=6

# ── Color detection ───────────────────────────────────────────────────────────

USE_COLOR=0
if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-}" != "dumb" ]]; then
  USE_COLOR=1
fi

if (( USE_COLOR )); then
  C_RESET="\033[0m"
  C_BOLD="\033[1m"
  C_DIM="\033[2m"
  C_GREEN="\033[32m"
  C_CYAN="\033[36m"
  C_YELLOW="\033[33m"
  C_RED="\033[31m"
  C_WHITE="\033[37m"
  CHECKMARK="\xe2\x9c\x93"   # ✓
  CROSSMARK="\xe2\x9c\x97"   # ✗
  ARROW="\xe2\x86\x92"       # →
  BOX_TL="\xe2\x94\x8c"      # ┌
  BOX_TR="\xe2\x94\x90"      # ┐
  BOX_BL="\xe2\x94\x94"      # └
  BOX_BR="\xe2\x94\x98"      # ┘
  BOX_H="\xe2\x94\x80"       # ─
  BOX_V="\xe2\x94\x82"       # │
  BOX_LT="\xe2\x94\x9c"      # ├
  BOX_RT="\xe2\x94\xa4"      # ┤
else
  C_RESET=""
  C_BOLD=""
  C_DIM=""
  C_GREEN=""
  C_CYAN=""
  C_YELLOW=""
  C_RED=""
  C_WHITE=""
  CHECKMARK="[OK]"
  CROSSMARK="[FAIL]"
  ARROW="-->"
  BOX_TL="+"
  BOX_TR="+"
  BOX_BL="+"
  BOX_BR="+"
  BOX_H="-"
  BOX_V="|"
  BOX_LT="+"
  BOX_RT="+"
fi

# ── TUI helpers ───────────────────────────────────────────────────────────────

print_success() { printf "  %b%b %s%b\n" "${C_GREEN}${C_BOLD}" "$CHECKMARK" "$1" "$C_RESET"; }
print_warn()    { printf "  %b! %s%b\n" "${C_YELLOW}${C_BOLD}" "$1" "$C_RESET"; }
print_error()   { printf "  %b%b %s%b\n" "${C_RED}${C_BOLD}" "$CROSSMARK" "$1" "$C_RESET"; }
print_info()    { printf "  %b%b %s%b\n" "${C_DIM}" "$ARROW" "$1" "$C_RESET"; }
fatal()         { print_error "$1"; exit 1; }

draw_hline() {
  local width="$1"
  local i
  for (( i=0; i<width; i++ )); do printf '%b' "$BOX_H"; done
}

print_step_header() {
  local step="$1" title="$2"
  local label="  Step ${step}/${TOTAL_STEPS}: ${title}  "
  local label_len=${#label}
  local width=$(( label_len > 44 ? label_len : 44 ))
  local pad=$(( width - label_len ))

  echo
  printf "  %b" "$BOX_TL"; draw_hline "$width"; printf '%b\n' "$BOX_TR"
  printf "  %b%b%s%b" "$BOX_V" "${C_BOLD}${C_CYAN}" " Step ${step}/${TOTAL_STEPS}:" "$C_RESET"
  printf " %b%s%b" "${C_BOLD}${C_WHITE}" "$title" "$C_RESET"
  # pad remaining space
  local content_so_far="  Step ${step}/${TOTAL_STEPS}: ${title}"
  local remaining=$(( width - ${#content_so_far} ))
  printf '%*s' "$remaining" ""
  printf '%b\n' "$BOX_V"
  printf "  %b" "$BOX_BL"; draw_hline "$width"; printf '%b\n' "$BOX_BR"
  echo
}

spinner_start() {
  SPINNER_MSG="$1"
  if (( ! USE_COLOR )); then
    printf "  ... %s" "$SPINNER_MSG"
    return
  fi
  tput civis 2>/dev/null || true
  (
    local frames=("⠋" "⠙" "⠹" "⠸" "⠼" "⠴" "⠦" "⠧" "⠇" "⠏")
    local i=0
    while true; do
      printf '\r  %b%s%b %s' "${C_CYAN}${C_BOLD}" "${frames[$i]}" "$C_RESET" "$SPINNER_MSG" >&2
      i=$(( (i + 1) % ${#frames[@]} ))
      sleep 0.08
    done
  ) &
  SPINNER_PID=$!
  disown "$SPINNER_PID" 2>/dev/null || true
}

spinner_stop() {
  local success="${1:-true}"
  if [[ -n "$SPINNER_PID" ]]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
    SPINNER_PID=""
  fi
  if (( USE_COLOR )); then
    printf '\r\033[K' >&2
    tput cnorm 2>/dev/null || true
  else
    echo >&2
  fi
  if [[ "$success" == "true" ]]; then
    print_success "$SPINNER_MSG"
  else
    print_error "$SPINNER_MSG"
  fi
}

cleanup() {
  if [[ -n "${SPINNER_PID:-}" ]]; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  tput cnorm 2>/dev/null || true
}
trap cleanup EXIT

mask_secret() {
  local secret="${1:-}"
  local len=${#secret}
  if (( len == 0 )); then
    printf ''
  elif (( len <= 8 )); then
    printf '%s' "$secret"
  else
    printf '%s…%s' "${secret:0:4}" "${secret: -4}"
  fi
}

prompt_value() {
  local var_name="$1" question="$2" default_value="${3:-}" override="${4-}"
  if [[ -n "$override" ]]; then
    printf -v "$var_name" '%s' "$override"
    return
  fi
  if (( NON_INTERACTIVE )); then
    printf -v "$var_name" '%s' "$default_value"
    return
  fi
  local prompt_suffix=""
  if [[ -n "$default_value" ]]; then
    prompt_suffix=" [${default_value}]"
  fi
  local answer
  read -rp "$(printf "  %b?%b %s%s " "${C_CYAN}${C_BOLD}" "${C_RESET}" "$question" "$prompt_suffix")" answer
  printf -v "$var_name" '%s' "${answer:-$default_value}"
}

prompt_secret() {
  local var_name="$1" question="$2" min_length="${3:-12}" override="${4-}"
  if [[ -n "$override" ]]; then
    if (( ${#override} < min_length )); then
      fatal "Password must be at least ${min_length} characters"
    fi
    printf -v "$var_name" '%s' "$override"
    return
  fi
  if (( NON_INTERACTIVE )); then
    fatal "Password is required in non-interactive mode (use --admin-pass)"
  fi
  local pass1 pass2
  while true; do
    printf "  %b?%b %s (min %d chars): " "${C_CYAN}${C_BOLD}" "${C_RESET}" "$question" "$min_length"
    read -rs pass1
    echo
    if (( ${#pass1} < min_length )); then
      print_error "Password must be at least ${min_length} characters"
      continue
    fi
    printf "  %b?%b Confirm password: " "${C_CYAN}${C_BOLD}" "${C_RESET}"
    read -rs pass2
    echo
    if [[ "$pass1" != "$pass2" ]]; then
      print_error "Passwords do not match"
      continue
    fi
    break
  done
  printf -v "$var_name" '%s' "$pass1"
}

ask_yes_no() {
  local question="$1" default_choice="${2:-y}"
  if (( NON_INTERACTIVE )); then
    [[ "${default_choice,,}" == "y" ]] && return 0 || return 1
  fi
  local prompt_hint answer
  case "${default_choice,,}" in
    y) prompt_hint="[Y/n]" ;;
    n) prompt_hint="[y/N]" ;;
    *) prompt_hint="[y/n]" ;;
  esac
  while true; do
    read -rp "$(printf "  %b?%b %s %s " "${C_CYAN}${C_BOLD}" "${C_RESET}" "$question" "$prompt_hint")" answer
    answer="${answer:-$default_choice}"
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) printf "  Please answer y or n.\n" ;;
    esac
  done
}

# ── Banner ────────────────────────────────────────────────────────────────────

CDX_BANNER="$(cat <<'EOF'
 ██████╗  ██████╗  ██████╗  ██████╗
██╔════╝ ██╔═══██╗██╔════╝ ██╔═══██╗    codex
██║      ██║   ██║██║      ██║   ██║    orchestrator
██║      ██║   ██║██║      ██║   ██║
╚██████╗ ╚██████╔╝╚██████╗ ╚██████╔╝
 ╚═════╝  ╚═════╝  ╚═════╝  ╚═════╝
EOF
)"

print_banner() {
  echo
  while IFS= read -r line; do
    printf "  %b%s%b\n" "${C_GREEN}${C_BOLD}" "$line" "$C_RESET"
  done <<<"$CDX_BANNER"
  echo
  printf "  %b%b── Quick Setup ──%b\n" "${C_CYAN}" "${C_BOLD}" "${C_RESET}"
  echo
}

# ── .env utilities ────────────────────────────────────────────────────────────

read_env_value() {
  local key="$1" file="$2" line
  line="$(LC_ALL=C grep -E "^[[:space:]]*${key}=" "$file" | tail -n 1 || true)"
  [[ -z "$line" ]] && return 1
  echo "${line#*=}"
}

set_env_value() {
  local key="$1" value="$2" file="$3" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done=0; re="^[ \t]*#?[ \t]*" k "=" }
    $0 ~ re {
      if (!done) { print k "=" v; done=1; next }
    }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" > "$tmp"
  mv "$tmp" "$file"
}

random_secret() {
  local length="${1:-24}"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 $((length * 2)) | tr -dc 'A-Za-z0-9' | head -c "$length"
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$length" <<'PY'
import os, sys, base64, re
length = int(sys.argv[1])
raw = base64.urlsafe_b64encode(os.urandom(length*2)).decode()
safe = re.sub(r'[^A-Za-z0-9]', '', raw)
print(safe[:length])
PY
    return
  fi
  tr -dc 'A-Za-z0-9' < /dev/urandom 2>/dev/null | head -c "$length"
}

generate_secretbox_key() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 32 | tr -d '\n'
    return
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import os, base64
print(base64.b64encode(os.urandom(32)).decode())
PY
    return
  fi
  echo ""
}

generate_uuid() {
  if command -v python3 >/dev/null 2>&1; then
    python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
    return
  fi
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen
    return
  fi
  random_secret 32
}

json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

# ── Docker helpers ────────────────────────────────────────────────────────────

install_docker_linux() {
  print_warn "Docker is not installed."
  if ! ask_yes_no "Install Docker now via get.docker.com?" "y"; then
    fatal "Docker is required. Install it manually and rerun setup."
  fi

  local installer
  installer="$(mktemp)"

  if command -v curl >/dev/null 2>&1; then
    print_info "Downloading Docker installer with curl..."
    curl -fsSL https://get.docker.com -o "$installer" || fatal "Failed to download Docker install script."
  elif command -v wget >/dev/null 2>&1; then
    print_info "Downloading Docker installer with wget..."
    wget -qO "$installer" https://get.docker.com || fatal "Failed to download Docker install script."
  else
    fatal "Need curl or wget to download Docker. Install one and rerun."
  fi

  local runner=(sh "$installer")
  if (( EUID != 0 )); then
    if command -v sudo >/dev/null 2>&1; then
      runner=(sudo sh "$installer")
    else
      fatal "Docker install needs root. Rerun as root or install sudo."
    fi
  fi

  print_info "Running Docker installer (this may prompt for sudo)..."
  if ! "${runner[@]}"; then
    fatal "Docker installation failed. Check the output above."
  fi

  rm -f "$installer"
  print_success "Docker installed"
}

install_docker_mac() {
  print_warn "Docker is not installed (macOS detected)."
  if ! ask_yes_no "Install Docker Desktop via Homebrew?" "y"; then
    fatal "Docker is required. Install Docker Desktop and rerun setup."
  fi
  require_cmd brew
  print_info "Installing Docker Desktop (brew install --cask docker)..."
  if ! brew install --cask docker; then
    fatal "Homebrew Docker Desktop installation failed."
  fi
  print_success "Docker Desktop installed"
  print_warn "Launch Docker Desktop once so the engine starts, then rerun setup."
  exit 0
}

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    print_success "Docker found"
    return
  fi

  case "$(uname -s)" in
    Linux)  install_docker_linux ;;
    Darwin) install_docker_mac ;;
    *)      fatal "Unsupported platform $(uname -s). Install Docker manually and rerun." ;;
  esac

  command -v docker >/dev/null 2>&1 || fatal "Docker still missing after install attempt."
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
    local ver
    ver="$(docker compose version --short 2>/dev/null || echo "unknown")"
    print_success "Docker Compose v2 found (${ver})"
    return
  fi
  fatal "docker compose v2 plugin is required. Install the Docker Compose plugin."
}

docker_healthcheck() {
  if docker info >/dev/null 2>&1; then
    print_success "Docker daemon is running"
    return
  fi

  print_warn "Docker daemon not reachable. Attempting to start..."
  local started=0
  if (( EUID != 0 )) && command -v sudo >/dev/null 2>&1; then
    if sudo systemctl start docker >/dev/null 2>&1; then
      started=1
    elif sudo service docker start >/dev/null 2>&1; then
      started=1
    fi
  else
    if systemctl start docker >/dev/null 2>&1; then
      started=1
    elif service docker start >/dev/null 2>&1; then
      started=1
    fi
  fi

  if (( started )) && docker info >/dev/null 2>&1; then
    print_success "Docker daemon started"
    return
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    print_warn "On macOS, open Docker Desktop and wait for it to finish starting."
  fi
  fatal "Docker daemon not reachable. Start Docker and rerun."
}

# ── Argument parsing ──────────────────────────────────────────────────────────

usage() {
  cat <<'EOF'
Usage: bin/setup-quick.sh [options]

Quick guided setup: goes from empty server to running Codex Orchestrator
with an admin user. No mTLS, no Caddy -- just Docker, MySQL, and the API.

Options:
  --non-interactive       Use flags/defaults; never prompt
  --data-root PATH        Data root directory (default: /var/docker_data/codex-orchestrator)
  --url URL               Public base URL (e.g. https://codex.example.com)
  --admin-name NAME       Admin full name
  --admin-user USER       Admin username (3-64 chars, lowercase)
  --admin-email EMAIL     Admin email address
  --admin-pass PASS       Admin password (min 12 chars)
  --no-build              Skip docker compose build
  --no-up                 Skip docker compose up (also skips user creation)
  -h, --help              Show this help
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --non-interactive) NON_INTERACTIVE=1 ;;
      --data-root)       DATA_ROOT_ARG="$2"; shift ;;
      --url)             URL_ARG="$2"; shift ;;
      --admin-name)      ADMIN_NAME_ARG="$2"; shift ;;
      --admin-user)      ADMIN_USER_ARG="$2"; shift ;;
      --admin-email)     ADMIN_EMAIL_ARG="$2"; shift ;;
      --admin-pass)      ADMIN_PASS_ARG="$2"; shift ;;
      --no-build)        BUILD_IMAGES=0 ;;
      --no-up|--no-start) START_STACK=0 ;;
      -h|--help)         usage; exit 0 ;;
      *)                 fatal "Unknown option: $1" ;;
    esac
    shift
  done

  # In non-interactive mode with --no-up, admin flags are optional.
  if (( NON_INTERACTIVE && START_STACK )); then
    local missing=()
    [[ -z "$ADMIN_NAME_ARG" ]]  && missing+=(--admin-name)
    [[ -z "$ADMIN_USER_ARG" ]]  && missing+=(--admin-user)
    [[ -z "$ADMIN_EMAIL_ARG" ]] && missing+=(--admin-email)
    [[ -z "$ADMIN_PASS_ARG" ]]  && missing+=(--admin-pass)
    if (( ${#missing[@]} > 0 )); then
      fatal "Non-interactive mode requires: ${missing[*]}"
    fi
  fi
}

# ── Phase 1: Prerequisites ───────────────────────────────────────────────────

phase_prerequisites() {
  print_step_header 1 "Prerequisites"

  local os_name
  os_name="$(uname -s)"
  print_info "Detected OS: ${os_name} ($(uname -m))"

  ensure_docker
  detect_compose
  docker_healthcheck

  if command -v curl >/dev/null 2>&1; then
    print_success "curl found"
  else
    fatal "curl is required for admin user creation. Install curl and rerun."
  fi
}

# ── Phase 2: Environment ─────────────────────────────────────────────────────

phase_environment() {
  print_step_header 2 "Environment"

  local template="$ROOT_DIR/.env.example"
  ENV_FILE="$ROOT_DIR/.env"

  if [[ -f "$ENV_FILE" ]]; then
    print_info "Using existing .env file"
  else
    [[ -f "$template" ]] || fatal "Template .env.example not found at $template"
    cp "$template" "$ENV_FILE"
    chmod 600 "$ENV_FILE" || true
    print_success "Created .env from template"
  fi

  # ── Auto-generate secrets ──

  local current

  # Encryption key
  current="$(read_env_value "AUTH_ENCRYPTION_KEY" "$ENV_FILE" || true)"
  if [[ -z "${current:-}" ]]; then
    local enc_key
    enc_key="$(generate_secretbox_key)"
    if [[ -n "$enc_key" ]]; then
      set_env_value "AUTH_ENCRYPTION_KEY" "$enc_key" "$ENV_FILE"
      print_success "Generated encryption key"
    else
      print_warn "Could not generate encryption key (no openssl/python3). Container will auto-generate on first boot."
    fi
  else
    print_info "Encryption key already set"
  fi

  # Installation ID
  current="$(read_env_value "INSTALLATION_ID" "$ENV_FILE" || true)"
  if [[ -z "${current:-}" ]]; then
    local inst_id
    inst_id="$(generate_uuid)"
    if [[ -n "$inst_id" ]]; then
      set_env_value "INSTALLATION_ID" "$inst_id" "$ENV_FILE"
      print_success "Generated installation ID"
    else
      print_warn "Could not generate installation ID."
    fi
  else
    print_info "Installation ID already set"
  fi

  # Database credentials
  local db_user db_pass db_root db_updated=0

  db_user="$(read_env_value "DB_USERNAME" "$ENV_FILE" || true)"
  db_pass="$(read_env_value "DB_PASSWORD" "$ENV_FILE" || true)"
  db_root="$(read_env_value "DB_ROOT_PASSWORD" "$ENV_FILE" || true)"

  if [[ -z "$db_user" || "$db_user" == "codex" ]]; then
    db_user="codex$(random_secret 6 | tr '[:upper:]' '[:lower:]')"
    set_env_value "DB_USERNAME" "$db_user" "$ENV_FILE"
    db_updated=1
  fi
  if [[ -z "$db_pass" || "$db_pass" == "codex-pass" ]]; then
    db_pass="$(random_secret 24)"
    set_env_value "DB_PASSWORD" "$db_pass" "$ENV_FILE"
    db_updated=1
  fi
  if [[ -z "$db_root" || "$db_root" == "root-pass" ]]; then
    db_root="$(random_secret 24)"
    set_env_value "DB_ROOT_PASSWORD" "$db_root" "$ENV_FILE"
    db_updated=1
  fi

  if (( db_updated )); then
    print_success "Generated database credentials"
    print_info "  DB_USERNAME:      ${db_user}"
    print_info "  DB_PASSWORD:      $(mask_secret "$db_pass")"
    print_info "  DB_ROOT_PASSWORD: $(mask_secret "$db_root")"
  else
    print_info "Database credentials already set"
  fi

  # ── Data root ──

  local data_root
  data_root="$(read_env_value "DATA_ROOT" "$ENV_FILE" || true)"
  local default_data_root="/var/docker_data/codex-orchestrator"
  if [[ -z "$data_root" || "$data_root" == "/var/docker_data/codex-auth.example.com" ]]; then
    data_root="$default_data_root"
  fi
  prompt_value data_root "Where should persistent data be stored?" "$data_root" "$DATA_ROOT_ARG"
  [[ "$data_root" != /* ]] && data_root="$ROOT_DIR/${data_root#./}"
  set_env_value "DATA_ROOT" "$data_root" "$ENV_FILE"
  DATA_ROOT_SELECTED="$data_root"

  # Create data directories
  mkdir -p "$data_root"/{store,store/sql,store/logs,mysql_data,backups} 2>/dev/null \
    || sudo mkdir -p "$data_root"/{store,store/sql,store/logs,mysql_data,backups} \
    || fatal "Failed to create data directories under $data_root"
  chmod -R 775 "$data_root/store" "$data_root/backups" 2>/dev/null || true
  if id -u www-data >/dev/null 2>&1; then
    chown -R www-data:www-data "$data_root/store" "$data_root/backups" 2>/dev/null || true
  fi
  print_success "Data directories ready at ${data_root}"

  # ── Public URL ──

  local public_url
  public_url="$(read_env_value "PUBLIC_BASE_URL" "$ENV_FILE" || true)"
  if [[ -z "$public_url" || "$public_url" == "https://codex-auth.example.com" ]]; then
    public_url="http://localhost:8488"
  fi
  prompt_value public_url "Public base URL for this instance" "$public_url" "$URL_ARG"

  # Extract domain
  local domain
  domain="${public_url#*://}"
  domain="${domain%%/*}"
  domain="${domain%%:*}"

  set_env_value "PUBLIC_BASE_URL" "$public_url" "$ENV_FILE"
  set_env_value "CODEX_SYNC_BASE_URL" "$public_url" "$ENV_FILE"
  set_env_value "AUTH_RUNNER_CODEX_BASE_URL" "$public_url" "$ENV_FILE"
  if [[ -n "$domain" ]]; then
    set_env_value "CADDY_DOMAIN" "$domain" "$ENV_FILE"
  fi
  PUBLIC_URL="$public_url"
  print_success "Base URL set to ${public_url}"

  # ── Fixed config ──

  set_env_value "ADMIN_ACCESS_MODE" "none" "$ENV_FILE"
  print_info "Admin access mode: password-only (no mTLS)"

  # Final permissions
  chmod 600 "$ENV_FILE" || true
  if id -u www-data >/dev/null 2>&1; then
    chown root:www-data "$ENV_FILE" 2>/dev/null || true
    chmod 640 "$ENV_FILE" 2>/dev/null || true
  fi
}

# ── Phase 3: Admin user ──────────────────────────────────────────────────────

phase_admin_user() {
  print_step_header 3 "Admin Account"

  if (( ! START_STACK )); then
    print_info "Stack will not start (--no-up). Skipping admin user setup."
    print_info "Create your first admin user via the dashboard after starting the stack."
    return
  fi

  # Name
  while true; do
    prompt_value ADMIN_NAME "Full name" "" "$ADMIN_NAME_ARG"
    if [[ -n "$ADMIN_NAME" ]]; then
      break
    fi
    print_error "Name is required"
    [[ -n "$ADMIN_NAME_ARG" ]] && fatal "Invalid --admin-name value"
  done

  # Username
  while true; do
    prompt_value ADMIN_USERNAME "Username" "" "$ADMIN_USER_ARG"
    ADMIN_USERNAME="${ADMIN_USERNAME,,}"
    if [[ "$ADMIN_USERNAME" =~ ^[a-z0-9._-]{3,64}$ ]]; then
      break
    fi
    print_error "Username must be 3-64 chars: lowercase letters, numbers, . _ -"
    [[ -n "$ADMIN_USER_ARG" ]] && fatal "Invalid --admin-user value"
  done

  # Email
  while true; do
    prompt_value ADMIN_EMAIL "Email" "" "$ADMIN_EMAIL_ARG"
    ADMIN_EMAIL="${ADMIN_EMAIL,,}"
    if [[ "$ADMIN_EMAIL" =~ ^[^@]+@[^@]+\.[^@]+$ ]]; then
      break
    fi
    print_error "Invalid email address"
    [[ -n "$ADMIN_EMAIL_ARG" ]] && fatal "Invalid --admin-email value"
  done

  # Password
  prompt_secret ADMIN_PASSWORD "Password" 12 "$ADMIN_PASS_ARG"

  print_success "Admin account details collected for: ${ADMIN_USERNAME}"
}

# ── Phase 4: Build & start ───────────────────────────────────────────────────

phase_build_start() {
  print_step_header 4 "Build & Launch"

  COMPOSE=(docker compose)

  if (( BUILD_IMAGES )); then
    print_info "Building Docker images (this may take a few minutes on first run)..."
    echo
    if ! "${COMPOSE[@]}" build --pull; then
      fatal "Docker build failed. Check the output above."
    fi
    echo
    print_success "Docker images built"
  else
    print_info "Skipping build (--no-build)"
  fi

  if (( ! START_STACK )); then
    print_info "Skipping stack startup (--no-up)"
    return
  fi

  print_info "Starting Docker stack..."
  if ! "${COMPOSE[@]}" up -d; then
    fatal "docker compose up failed. Check: docker compose logs"
  fi
  print_success "Docker stack started"

  # Wait for API health
  local domain
  domain="${PUBLIC_URL#*://}"
  domain="${domain%%/*}"

  spinner_start "Waiting for API to become healthy (migrations running on first boot)..."
  local elapsed=0 timeout=180
  while (( elapsed < timeout )); do
    if curl -sf -H "Host: ${domain}" http://127.0.0.1:8488/versions >/dev/null 2>&1; then
      spinner_stop true
      return
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  spinner_stop false
  echo
  print_warn "Troubleshooting: run 'docker compose logs api' to see what happened."
  fatal "API failed to become healthy within ${timeout} seconds."
}

# ── Phase 5: Create admin user ────────────────────────────────────────────────

phase_create_admin() {
  print_step_header 5 "Register Admin User"

  if (( ! START_STACK )); then
    print_info "Stack not running. Skipping user creation."
    return
  fi

  if [[ -z "$ADMIN_USERNAME" ]]; then
    print_info "No admin user details collected. Skipping."
    return
  fi

  local domain
  domain="${PUBLIC_URL#*://}"
  domain="${domain%%/*}"

  # Build JSON with proper escaping
  local j_name j_user j_email j_pass
  j_name="$(json_escape "$ADMIN_NAME")"
  j_user="$(json_escape "$ADMIN_USERNAME")"
  j_email="$(json_escape "$ADMIN_EMAIL")"
  j_pass="$(json_escape "$ADMIN_PASSWORD")"

  local json_body
  json_body="{\"name\":\"${j_name}\",\"username\":\"${j_user}\",\"email\":\"${j_email}\",\"password\":\"${j_pass}\",\"access_level\":\"admin\",\"active\":true}"

  spinner_start "Creating admin user '${ADMIN_USERNAME}'..."

  local http_response http_code body
  http_response="$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Host: ${domain}" \
    http://127.0.0.1:8488/admin/users \
    -d "$json_body" 2>&1)" || true

  http_code="$(echo "$http_response" | tail -n 1)"
  body="$(echo "$http_response" | sed '$d')"

  if [[ "$http_code" == "200" ]] && echo "$body" | grep -q '"status":"ok"'; then
    spinner_stop true
  else
    spinner_stop false
    echo
    print_info "HTTP ${http_code}"
    # Try to extract error message
    local err_msg
    err_msg="$(echo "$body" | grep -o '"message":"[^"]*"' | head -1 | sed 's/"message":"//;s/"$//' || true)"
    if [[ -n "$err_msg" ]]; then
      print_info "Server response: ${err_msg}"
    fi
    # Check for validation errors
    local val_errs
    val_errs="$(echo "$body" | grep -o '"errors":{[^}]*}' | head -1 || true)"
    if [[ -n "$val_errs" ]]; then
      print_info "Validation: ${val_errs}"
    fi
    fatal "Failed to create admin user. Check the API logs: docker compose logs api"
  fi

  # Clear the password from memory
  ADMIN_PASSWORD=""
}

# ── Phase 6: Summary ─────────────────────────────────────────────────────────

phase_summary() {
  print_step_header 6 "Setup Complete"

  local local_url="http://localhost:8488/admin/"
  local public_dashboard=""
  if [[ "$PUBLIC_URL" != "http://localhost:8488" ]]; then
    public_dashboard="${PUBLIC_URL}/admin/"
  fi

  local data_root="${DATA_ROOT_SELECTED:-/var/docker_data/codex-orchestrator}"

  # Build summary lines
  local lines=()
  lines+=("")
  lines+=("  Codex Orchestrator is running!")
  lines+=("")
  if (( START_STACK )); then
    lines+=("  Dashboard (local):   ${local_url}")
    if [[ -n "$public_dashboard" ]]; then
      lines+=("  Dashboard (public):  ${public_dashboard}")
    fi
    if [[ -n "$ADMIN_USERNAME" ]]; then
      lines+=("  Admin user:          ${ADMIN_USERNAME}")
    fi
  fi
  lines+=("  Data root:           ${data_root}")
  lines+=("  Config:              ${ENV_FILE}")
  lines+=("")

  # Find max line length
  local max_len=0
  for line in "${lines[@]}"; do
    (( ${#line} > max_len )) && max_len=${#line}
  done
  local box_width=$(( max_len + 2 ))
  (( box_width < 52 )) && box_width=52

  # Draw top
  printf "\n  %b%b" "${C_GREEN}${C_BOLD}" "$BOX_TL"
  draw_hline "$box_width"
  printf '%b%b\n' "$BOX_TR" "$C_RESET"

  # Draw content
  for line in "${lines[@]}"; do
    local pad=$(( box_width - ${#line} ))
    printf "  %b%b%b%s%*s%b%b%b\n" "${C_GREEN}${C_BOLD}" "$BOX_V" "$C_RESET" "$line" "$pad" "" "${C_GREEN}${C_BOLD}" "$BOX_V" "$C_RESET"
  done

  # Separator
  printf "  %b%b" "${C_GREEN}${C_BOLD}" "$BOX_LT"
  draw_hline "$box_width"
  printf '%b%b\n' "$BOX_RT" "$C_RESET"

  # Next steps
  local next_lines=()
  next_lines+=("")
  next_lines+=("  Next steps:")
  if (( START_STACK )); then
    next_lines+=("    1. Log in at ${local_url}")
    next_lines+=("    2. Upload your auth.json via the dashboard")
    next_lines+=("    3. Register hosts and mint installer tokens")
  else
    next_lines+=("    1. Build and start: docker compose up --build -d")
    next_lines+=("    2. Create your admin user in the dashboard")
    next_lines+=("    3. Upload auth.json and register hosts")
  fi
  next_lines+=("")
  next_lines+=("  For production:")
  next_lines+=("    - Set up a reverse proxy (nginx/caddy) with TLS")
  next_lines+=("    - mTLS for /admin is optional advanced config")
  next_lines+=("    - See docs/INSTALL.md for details")
  next_lines+=("")

  for line in "${next_lines[@]}"; do
    local pad=$(( box_width - ${#line} ))
    (( pad < 0 )) && pad=0
    printf "  %b%b%b%b%s%b%*s%b%b%b\n" "${C_GREEN}${C_BOLD}" "$BOX_V" "$C_RESET" "${C_DIM}" "$line" "$C_RESET" "$pad" "" "${C_GREEN}${C_BOLD}" "$BOX_V" "$C_RESET"
  done

  # Bottom
  printf "  %b%b" "${C_GREEN}${C_BOLD}" "$BOX_BL"
  draw_hline "$box_width"
  printf '%b%b\n' "$BOX_BR" "$C_RESET"
  echo
}

# ── Main ──────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  print_banner
  phase_prerequisites
  phase_environment
  phase_admin_user
  phase_build_start
  phase_create_admin
  phase_summary
}

main "$@"
