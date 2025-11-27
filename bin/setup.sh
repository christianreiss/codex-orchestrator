#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

info() { printf '[setup] %s\n' "$*"; }
warn() { printf '[setup][warn] %s\n' "$*" >&2; }
fatal() { printf '[setup][error] %s\n' "$*" >&2; exit 1; }

COLOR_OK=""; COLOR_WARN=""; COLOR_RESET=""; COLOR_PROMPT=""
if [[ -t 1 ]]; then
  COLOR_OK="\033[32m\033[1m"
  COLOR_WARN="\033[33m\033[1m"
  COLOR_RESET="\033[0m"
  COLOR_PROMPT="\033[36m\033[1m"
fi

CDX_BANNER="$(cat <<'EOF'
  ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗
 ██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝
 ██║     ██║   ██║██║  ██║█████╗   ╚███╔╝ 
 ██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗ 
 ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗
  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝
                                           
  ██████╗ ██████╗  ██████╗ ██████╗ ██████╗ ██╗███╗   ██╗ █████╗ ████████╗ ██████╗ ██████╗ 
 ██╔════╝██╔═══██╗██╔═══██╗██╔══██╗██╔══██╗██║████╗  ██║██╔══██╗╚══██╔══╝██╔═══██╗██╔══██╗
 ██║     ██║   ██║██║   ██║██████╔╝██║  ██║██║██╔██╗ ██║███████║   ██║   ██║   ██║██████╔╝
 ██║     ██║   ██║██║   ██║██╔══██╗██║  ██║██║██║╚██╗██║██╔══██║   ██║   ██║   ██║██╔══██╗
 ╚██████╗╚██████╔╝╚██████╔╝██║  ██║██████╔╝██║██║ ╚████║██║  ██║   ██║   ╚██████╔╝██║  ██║
  ╚═════╝ ╚═════╝  ╚═════╝ ╚═╝  ╚═╝╚═════╝ ╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝   ╚═╝    ╚═════╝ ╚═╝  ╚═╝
EOF
)"

print_banner() {
  while IFS= read -r line; do
    printf "%b%s%b\n" "${COLOR_OK}" "$line" "${COLOR_RESET}"
  done <<<"$CDX_BANNER"
}

mask_secret() {
  local secret="$1" len=${#secret}
  if (( len <= 8 )); then
    printf '%s' "$secret"
  else
    printf '%s…%s' "${secret:0:4}" "${secret: -4}"
  fi
}

prompt_value() {
  local var_name="$1" question="$2" default_value="${3:-}"
  local prompt_suffix=""
  if [[ -n "$default_value" ]]; then
    prompt_suffix=" [${default_value}]"
  fi
  local answer
  read -rp "$(printf "%b?%b %s%s " "${COLOR_PROMPT}" "${COLOR_RESET}" "$question" "$prompt_suffix")" answer
  printf -v "$var_name" '%s' "${answer:-$default_value}"
}

ask_yes_no() {
  local question="$1" default_choice="${2:-y}" answer prompt_hint
  case "${default_choice,,}" in
    y) prompt_hint="[Y/n]" ;;
    n) prompt_hint="[y/N]" ;;
    *) prompt_hint="[y/n]" ;;
  esac
  while true; do
    read -rp "$(printf "%b?%b %s %s " "${COLOR_PROMPT}" "${COLOR_RESET}" "$question" "$prompt_hint")" answer
    answer="${answer:-$default_choice}"
    case "${answer,,}" in
      y|yes) return 0 ;;
      n|no) return 1 ;;
      *) printf "Please answer y or n.\n" ;;
    esac
  done
}

usage() {
  cat <<'EOF'
Usage: bin/setup.sh [options]

Preps the repo for a first-time Codex Auth install: creates .env, ensures data
directories exist, and optionally builds/starts the Docker stack.

Options:
  --prepare-only   Create .env + data dirs (no Docker build/up)
  --no-build       Skip docker compose build (still runs up)
  --no-up          Skip docker compose up (after prep/build)
  -h, --help       Show this help
EOF
}

parse_args() {
  BUILD_IMAGES=1
  START_STACK=1
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --prepare-only) BUILD_IMAGES=0; START_STACK=0 ;;
      --no-build) BUILD_IMAGES=0 ;;
      --no-up|--no-start) START_STACK=0 ;;
      -h|--help) usage; exit 0 ;;
      *) fatal "Unknown option: $1" ;;
    esac
    shift
  done
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

check_requirements() {
  local required=(docker grep awk cp chmod mkdir mktemp tail tr head)
  for bin in "${required[@]}"; do
    require_cmd "$bin"
  done
}

detect_compose() {
  if docker compose version >/dev/null 2>&1; then
    COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE=(docker-compose)
  else
    fatal "docker compose is required (plugin or docker-compose)"
  fi
}

USE_CADDY=0

configure_caddy() {
  local env_file="$1" data_root="$2"

  if ! ask_yes_no "Enable bundled Caddy TLS/mTLS reverse proxy on ports 80/443?" "y"; then
    info "Caddy disabled; API will remain on :8488 without the caddy profile."
    USE_CADDY=0
    return
  fi

  USE_CADDY=1

  local domain default_domain
  default_domain="$(read_env_value "CADDY_DOMAIN" "$env_file" || true)"
  [[ -z "$default_domain" ]] && default_domain="codex-auth.example.com"
  prompt_value domain "Primary HTTPS domain" "$default_domain"
  set_env_value "CADDY_DOMAIN" "$domain" "$env_file"

  local tls_dir mtls_dir
  tls_dir="$(read_env_value "CADDY_TLS_DIR" "$env_file" || true)"
  [[ -z "$tls_dir" ]] && tls_dir="$data_root/caddy/tls"
  [[ "$tls_dir" != /* ]] && tls_dir="$ROOT_DIR/${tls_dir#./}"
  mtls_dir="$(read_env_value "CADDY_MTLS_DIR" "$env_file" || true)"
  [[ -z "$mtls_dir" ]] && mtls_dir="$data_root/caddy/mtls"
  [[ "$mtls_dir" != /* ]] && mtls_dir="$ROOT_DIR/${mtls_dir#./}"
  ensure_dir "$tls_dir"
  ensure_dir "$mtls_dir"
  set_env_value "CADDY_TLS_DIR" "$tls_dir" "$env_file"
  set_env_value "CADDY_MTLS_DIR" "$mtls_dir" "$env_file"

  echo
  echo "TLS options:"
  echo "  1) Let's Encrypt / ZeroSSL (ACME)"
  echo "  2) Use my own cert/key"
  echo "  3) Generate self-signed cert now"
  local tls_choice
  while true; do
    prompt_value tls_choice "Pick TLS mode [1-3]" "1"
    case "$tls_choice" in
      1|2|3) break ;;
      *) echo "Choose 1, 2, or 3." ;;
    esac
  done

  case "$tls_choice" in
    1)
      local acme_email
      acme_email="$(read_env_value "CADDY_ACME_EMAIL" "$env_file" || true)"
      [[ -z "$acme_email" ]] && acme_email="ops@example.com"
      prompt_value acme_email "ACME email for Let's Encrypt/ZeroSSL" "$acme_email"
      set_env_value "CADDY_ACME_EMAIL" "$acme_email" "$env_file"
      set_env_value "CADDY_TLS_FRAGMENT" "/etc/caddy/tls-acme.caddy" "$env_file"
      set_env_value "CADDY_TLS_CERT_FILE" "/etc/caddy/tls/tls.crt" "$env_file"
      set_env_value "CADDY_TLS_KEY_FILE" "/etc/caddy/tls/tls.key" "$env_file"
      info "ACME enabled. Ensure ports 80/443 on ${domain} reach this host."
      ;;
    2)
      local cert_file key_file
      cert_file="$(basename "$(read_env_value "CADDY_TLS_CERT_FILE" "$env_file" || echo "/etc/caddy/tls/tls.crt")")"
      key_file="$(basename "$(read_env_value "CADDY_TLS_KEY_FILE" "$env_file" || echo "/etc/caddy/tls/tls.key")")"
      prompt_value cert_file "Cert filename inside ${tls_dir}" "$cert_file"
      prompt_value key_file "Key filename inside ${tls_dir}" "$key_file"
      set_env_value "CADDY_TLS_CERT_FILE" "/etc/caddy/tls/${cert_file}" "$env_file"
      set_env_value "CADDY_TLS_KEY_FILE" "/etc/caddy/tls/${key_file}" "$env_file"
      set_env_value "CADDY_TLS_FRAGMENT" "/etc/caddy/tls-custom.caddy" "$env_file"
      info "Place your TLS files at ${tls_dir}/${cert_file} and ${tls_dir}/${key_file} before starting Caddy."
      ;;
    3)
      local san_csv
      prompt_value san_csv "Extra SANs (comma separated, blank for none)" "localhost,127.0.0.1"
      generate_ca "$tls_dir" "${domain} CA"
      generate_server_cert "$tls_dir" "$tls_dir/ca.key" "$tls_dir/ca.crt" "$domain" "$san_csv"
      set_env_value "CADDY_TLS_FRAGMENT" "/etc/caddy/tls-custom.caddy" "$env_file"
      set_env_value "CADDY_TLS_CERT_FILE" "/etc/caddy/tls/server.crt" "$env_file"
      set_env_value "CADDY_TLS_KEY_FILE" "/etc/caddy/tls/server.key" "$env_file"
      info "Self-signed TLS ready. Trust ${tls_dir}/ca.crt on clients that hit https://${domain}."
      ;;
  esac

  echo
  echo "mTLS for /admin (client cert required):"
  echo "  1) I have a CA cert already (will copy into place)"
  echo "  2) Generate a fresh admin CA + client cert now"
  local mtls_choice
  while true; do
    prompt_value mtls_choice "Choose mTLS CA option [1-2]" "2"
    case "$mtls_choice" in
      1|2) break ;;
      *) echo "Choose 1 or 2." ;;
    esac
  done

  set_env_value "CADDY_MTLS_CA_FILE" "/etc/caddy/mtls/ca.crt" "$env_file"

  case "$mtls_choice" in
    1)
      local ca_path
      prompt_value ca_path "Path to your existing CA cert" ""
      if [[ -n "$ca_path" && -f "$ca_path" ]]; then
        cp "$ca_path" "$mtls_dir/ca.crt"
        info "Copied CA to $mtls_dir/ca.crt"
      else
        warn "CA file not found; place your CA cert at $mtls_dir/ca.crt before starting."
      fi
      ;;
    2)
      local ca_cn client_cn
      prompt_value ca_cn "Admin CA Common Name" "Codex Admin CA"
      prompt_value client_cn "Admin client cert name (CN)" "codex-admin"
      generate_ca "$mtls_dir" "$ca_cn"
      generate_client_cert "$mtls_dir" "$mtls_dir/ca.key" "$mtls_dir/ca.crt" "$client_cn" "client-admin"
      info "mTLS CA: $mtls_dir/ca.crt"
      info "Client cert/key: $mtls_dir/client-admin.crt / $mtls_dir/client-admin.key (import into your admin browser/cli)."
      ;;
  esac
}

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

ensure_env_file() {
  local target="$1" template="$2"
  if [[ -f "$target" ]]; then
    info "Using existing env file: $target"
    return 1
  fi

  [[ -f "$template" ]] || fatal "Template env file missing at $template"
  cp "$template" "$target"
  chmod 600 "$target" || true
  info "Created $target from $(basename "$template")"
  return 0
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

ensure_encryption_key() {
  local env_file="$1"
  local current key tmp
  current="$(read_env_value "AUTH_ENCRYPTION_KEY" "$env_file" || true)"
  if [[ -n "${current:-}" ]]; then
    return
  fi

  key="$(generate_secretbox_key)"
  if [[ -z "$key" ]]; then
    warn "Could not generate AUTH_ENCRYPTION_KEY (no openssl/python3); container will auto-generate on first boot."
    return
  fi

  if grep -Eq '^[[:space:]]*#?[[:space:]]*AUTH_ENCRYPTION_KEY=' "$env_file"; then
    tmp="$(mktemp)"
    awk -v k="$key" '
      BEGIN { done=0 }
      /^[ \t]*#?[ \t]*AUTH_ENCRYPTION_KEY=/ {
        if (!done) { print "AUTH_ENCRYPTION_KEY=" k; done=1; next }
      }
      { print }
      END { if (!done) print "AUTH_ENCRYPTION_KEY=" k }
    ' "$env_file" > "$tmp"
    mv "$tmp" "$env_file"
  else
    printf '\nAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$env_file"
  fi

  chmod 600 "$env_file" || true
  info "Wrote AUTH_ENCRYPTION_KEY to $env_file"
}

ensure_db_credentials() {
  local env_file="$1"
  local db_user db_pass db_root db_name updated=0

  db_user="$(read_env_value "DB_USERNAME" "$env_file" || true)"
  db_pass="$(read_env_value "DB_PASSWORD" "$env_file" || true)"
  db_root="$(read_env_value "DB_ROOT_PASSWORD" "$env_file" || true)"
  db_name="$(read_env_value "DB_DATABASE" "$env_file" || true)"

  if [[ -z "$db_user" || "$db_user" == "codex" ]]; then
    db_user="codex$(random_secret 6 | tr '[:upper:]' '[:lower:]')"
    set_env_value "DB_USERNAME" "$db_user" "$env_file"
    updated=1
  fi

  if [[ -z "$db_pass" || "$db_pass" == "codex-pass" ]]; then
    db_pass="$(random_secret 24)"
    set_env_value "DB_PASSWORD" "$db_pass" "$env_file"
    updated=1
  fi

  if [[ -z "$db_root" || "$db_root" == "root-pass" ]]; then
    db_root="$(random_secret 24)"
    set_env_value "DB_ROOT_PASSWORD" "$db_root" "$env_file"
    updated=1
  fi

  if [[ -z "$db_name" ]]; then
    db_name="codex_auth"
    set_env_value "DB_DATABASE" "$db_name" "$env_file"
  fi

  if (( updated )); then
    chmod 600 "$env_file" || true
    info "Generated MySQL credentials and wrote them to $env_file"
    info "DB_USERNAME: $db_user"
    info "DB_PASSWORD: $(mask_secret "$db_pass")"
    info "DB_ROOT_PASSWORD: $(mask_secret "$db_root")"
  fi
}

ensure_data_dirs() {
  local root="$1"
  mkdir -p "$root"/{store,store/sql,mysql_data,caddy/tls,caddy/mtls} || fatal "Failed to create data dirs under $root"
  info "Ensured data directories under $root"
}

ensure_dir() {
  local dir="$1"
  mkdir -p "$dir" || fatal "Failed to create directory: $dir"
}

ensure_openssl() {
  command -v openssl >/dev/null 2>&1 || fatal "openssl is required for certificate generation"
}

confirm_overwrite() {
  local path="$1"
  if [[ ! -e "$path" ]]; then
    return 0
  fi
  ask_yes_no "Overwrite existing $(basename "$path") at $(dirname "$path")?" "n"
}

generate_ca() {
  local dir="$1" cn="$2" key="$dir/ca.key" cert="$dir/ca.crt"
  ensure_openssl
  ensure_dir "$dir"
  if ! confirm_overwrite "$key" || ! confirm_overwrite "$cert"; then
    warn "Skipped regenerating CA; using existing files in $dir"
    return
  fi
  openssl req -x509 -new -nodes -sha256 -days 3650 \
    -subj "/CN=${cn}" \
    -newkey rsa:4096 \
    -keyout "$key" \
    -out "$cert" >/dev/null 2>&1
  chmod 600 "$key" 2>/dev/null || true
  info "Generated CA cert: $cert"
}

generate_server_cert() {
  local dir="$1" ca_key="$2" ca_cert="$3" cn="$4" san_csv="$5"
  ensure_openssl
  ensure_dir "$dir"
  local key="$dir/server.key"
  local cert="$dir/server.crt"
  local csr="$dir/server.csr"
  local ext="$dir/server.ext"

  if ! confirm_overwrite "$key" || ! confirm_overwrite "$cert"; then
    warn "Skipped regenerating server certificate; using existing files in $dir"
    return
  fi

  local san_lines=()
  local idx=1
  IFS=',' read -ra entries <<<"$san_csv"
  for entry in "${entries[@]}"; do
    entry="$(echo "$entry" | xargs)"
    [[ -z "$entry" ]] && continue
    if [[ "$entry" =~ ^[0-9.]+$ ]]; then
      san_lines+=("IP.$idx = $entry")
    else
      san_lines+=("DNS.$idx = $entry")
    fi
    ((idx++))
  done
  san_lines+=("DNS.$idx = $cn")

  cat > "$ext" <<EOF
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$(printf '%s\n' "${san_lines[@]}")
EOF

  openssl req -new -nodes -newkey rsa:4096 -keyout "$key" -subj "/CN=${cn}" -out "$csr" >/dev/null 2>&1
  openssl x509 -req -in "$csr" -CA "$ca_cert" -CAkey "$ca_key" -CAcreateserial \
    -out "$cert" -days 825 -sha256 -extfile "$ext" -extensions v3_req >/dev/null 2>&1

  rm -f "$csr" "$ext"
  chmod 600 "$key" 2>/dev/null || true
  info "Generated server cert: $cert"
}

generate_client_cert() {
  local dir="$1" ca_key="$2" ca_cert="$3" cn="$4" prefix="$5"
  ensure_openssl
  ensure_dir "$dir"
  local key="$dir/${prefix}.key"
  local cert="$dir/${prefix}.crt"
  local csr="$dir/${prefix}.csr"
  local ext="$dir/${prefix}.ext"

  if ! confirm_overwrite "$key" || ! confirm_overwrite "$cert"; then
    warn "Skipped regenerating client certificate; using existing files in $dir"
    return
  fi

  cat > "$ext" <<EOF
[v3_req]
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = clientAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${cn}
EOF

  openssl req -new -nodes -newkey rsa:4096 -keyout "$key" -subj "/CN=${cn}" -out "$csr" >/dev/null 2>&1
  openssl x509 -req -in "$csr" -CA "$ca_cert" -CAkey "$ca_key" -CAcreateserial \
    -out "$cert" -days 825 -sha256 -extfile "$ext" -extensions v3_req >/dev/null 2>&1

  rm -f "$csr" "$ext"
  chmod 600 "$key" 2>/dev/null || true
  info "Generated client cert: $cert"
}

docker_healthcheck() {
  if ! docker info >/dev/null 2>&1; then
    fatal "Docker daemon not reachable; start Docker and rerun"
  fi
}

start_stack() {
  local compose=("${COMPOSE[@]}")
  local profile_args=()
  (( USE_CADDY )) && profile_args+=(--profile caddy)
  if (( BUILD_IMAGES )); then
    info "Building images (docker compose ${profile_args[*]} build --pull)..."
    "${compose[@]}" "${profile_args[@]}" build --pull
  else
    info "Skipping docker compose build (per flag)"
  fi

  if (( START_STACK )); then
    info "Starting stack (docker compose ${profile_args[*]} up -d)..."
    "${compose[@]}" "${profile_args[@]}" up -d
    info "Stack status:"
    "${compose[@]}" ps
  else
    info "docker compose up skipped (per flag)"
  fi
}

main() {
  parse_args "$@"
  print_banner
  check_requirements
  detect_compose
  docker_healthcheck

  local env_path=".env"
  if [[ -n "${ENV_FILE:-}" ]]; then
    env_path="${ENV_FILE}"
  fi
  [[ "$env_path" != /* ]] && env_path="$ROOT_DIR/${env_path#./}"

  local template="$ROOT_DIR/.env.example"
  local created_env=0
  if ensure_env_file "$env_path" "$template"; then
    created_env=1
  fi

  ensure_encryption_key "$env_path"
  ensure_db_credentials "$env_path"

  local data_root default_data_root="/var/docker_data/codex-auth.example.com"
  data_root="$(read_env_value "DATA_ROOT" "$env_path" || true)"
  data_root="${data_root:-$default_data_root}"
  [[ "$data_root" != /* ]] && data_root="$ROOT_DIR/${data_root#./}"
  ensure_data_dirs "$data_root"

  configure_caddy "$env_path" "$data_root"

  local codex_url runner_url
  codex_url="$(read_env_value "CODEX_SYNC_BASE_URL" "$env_path" || true)"
  runner_url="$(read_env_value "AUTH_RUNNER_CODEX_BASE_URL" "$env_path" || true)"
  [[ -z "$codex_url" ]] && codex_url="https://codex-auth.example.com"
  [[ -z "$runner_url" ]] && runner_url="https://codex-auth.example.com"

  if (( START_STACK || BUILD_IMAGES )); then
    start_stack
  else
    info "Prep complete; Docker steps skipped."
  fi

  printf '\nNext steps:\n'
  printf '  - Review %s and set DB_*, DATA_ROOT, CODEX_SYNC_BASE_URL, AUTH_RUNNER_CODEX_BASE_URL (current: %s / %s).\n' "$env_path" "$codex_url" "$runner_url"
  local up_cmd="${COMPOSE[*]} up -d"
  (( USE_CADDY )) && up_cmd="${COMPOSE[*]} --profile caddy up -d"
  printf '  - Bring up the stack with: %s\n' "$up_cmd"
  printf '  - After the stack is running, upload your ~/.codex/auth.json via the admin dashboard (/admin/) and mint installer tokens per host.\n'
  if (( created_env )); then
    printf '\nNOTE: A fresh env file was created; update it before production use.\n'
  fi
}

main "$@"
