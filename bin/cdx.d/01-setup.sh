install_missing_commands() {
  local missing=("$@")
  local os=""
  os="$(uname -s)"
  case "$os" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        return 1
      fi
      local brew_missing=()
      local cmd pkg
      for cmd in "${missing[@]}"; do
        pkg="$cmd"
        case "$cmd" in
          python3) pkg="python" ;;
        esac
        brew_missing+=("$pkg")
      done
      log_info "Installing prerequisites (${missing[*]}) with Homebrew"
      brew install "${brew_missing[@]}" || return 1
      ;;
    Linux)
      local pm=""
      if ! pm="$(detect_linux_package_manager)"; then
        return 1
      fi

      local use_sudo=()
      if ((EUID != 0)); then
        if command -v sudo >/dev/null 2>&1; then
          use_sudo=(sudo)
        else
          return 1
        fi
      fi

      local install_missing=()
      local dep pkg
      for dep in "${missing[@]}"; do
        pkg="$dep"
        case "$pm:$dep" in
          apt-get:bwrap | dnf:bwrap | yum:bwrap)
            pkg="bubblewrap"
            ;;
          pacman:python3)
            pkg="python"
            ;;
          pacman:script | apk:script | dnf:script | yum:script)
            pkg="util-linux"
            ;;
        esac
        install_missing+=("$pkg")
      done

      case "$pm" in
        apt-get)
          log_info "Installing prerequisites (${missing[*]}) with apt-get"
          if ((${#use_sudo[@]} > 0)); then
            "${use_sudo[@]}" apt-get update -qq
            "${use_sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${install_missing[@]}" || return 1
          else
            apt-get update -qq
            DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${install_missing[@]}" || return 1
          fi
          ;;
        dnf)
          log_info "Installing prerequisites (${missing[*]}) with dnf"
          if ((${#use_sudo[@]} > 0)); then
            "${use_sudo[@]}" dnf install -y "${install_missing[@]}" || return 1
          else
            dnf install -y "${install_missing[@]}" || return 1
          fi
          ;;
        yum)
          log_info "Installing prerequisites (${missing[*]}) with yum"
          local yum_status=0
          if ((${#use_sudo[@]} > 0)); then
            "${use_sudo[@]}" yum install -y "${install_missing[@]}" || yum_status=$?
          else
            yum install -y "${install_missing[@]}" || yum_status=$?
          fi
          if ((yum_status != 0)); then
            local python_only_fallback=1
            local pkg_name
            for pkg_name in "${install_missing[@]}"; do
              if [[ "$pkg_name" != "python3" ]]; then
                python_only_fallback=0
                break
              fi
            done
            if ((python_only_fallback)); then
              log_info "Retrying legacy yum Python install with python36"
              if ((${#use_sudo[@]} > 0)); then
                "${use_sudo[@]}" yum install -y python36 || return 1
              else
                yum install -y python36 || return 1
              fi
            else
              return 1
            fi
          fi
          ;;
        pacman)
          log_info "Installing prerequisites (${missing[*]}) with pacman"
          if ((${#use_sudo[@]} > 0)); then
            "${use_sudo[@]}" pacman -S --noconfirm --needed "${install_missing[@]}" || return 1
          else
            pacman -S --noconfirm --needed "${install_missing[@]}" || return 1
          fi
          ;;
        zypper)
          log_info "Installing prerequisites (${missing[*]}) with zypper"
          if ((${#use_sudo[@]} > 0)); then
            "${use_sudo[@]}" zypper --non-interactive install --no-recommends "${install_missing[@]}" || return 1
          else
            zypper --non-interactive install --no-recommends "${install_missing[@]}" || return 1
          fi
          ;;
        apk)
          log_info "Installing prerequisites (${missing[*]}) with apk"
          if ((${#use_sudo[@]} > 0)); then
            "${use_sudo[@]}" apk add --no-cache "${install_missing[@]}" || return 1
          else
            apk add --no-cache "${install_missing[@]}" || return 1
          fi
          ;;
        *)
          return 1
          ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

ensure_commands() {
  local missing=()
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if ((${#missing[@]} == 0)); then
    return 0
  fi

  if ! install_missing_commands "${missing[@]}"; then
    log_error "Missing required commands: ${missing[*]}. Install them manually or rerun Codex as root to allow automatic installation."
    exit 1
  fi

  local still_missing=()
  for cmd in "${missing[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      still_missing+=("$cmd")
    fi
  done

  if ((${#still_missing[@]} > 0)); then
    log_error "Failed to install required commands: ${still_missing[*]}"
    exit 1
  fi

  activate_python3_shim || true
}

ensure_optional_commands() {
  local missing=()
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if ((${#missing[@]} == 0)); then
    return 0
  fi

  if ! install_missing_commands "${missing[@]}"; then
    log_warn "Optional prerequisites unavailable (${missing[*]}). Continuing; Codex may use built-in fallbacks."
    return 0
  fi

  local still_missing=()
  for cmd in "${missing[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      still_missing+=("$cmd")
    fi
  done

  if ((${#still_missing[@]} > 0)); then
    log_warn "Optional prerequisites still missing (${still_missing[*]}). Continuing; Codex may use built-in fallbacks."
  fi

  activate_python3_shim || true
}

is_codex_installed_via_npm() {
  if ! command -v npm >/dev/null 2>&1; then
    return 1
  fi
  if npm list -g codex-cli --depth=0 >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

update_codex_via_npm() {
  local target="$1"
  local cmd=(npm install -g)
  if ! command -v npm >/dev/null 2>&1; then
    return 1
  fi
  if [[ -z "$target" ]]; then
    cmd+=(codex-cli)
  else
    cmd+=("codex-cli@$target")
  fi

  if ((EUID == 0)); then
    "${cmd[@]}" >/dev/null
  elif ((CAN_SUDO)); then
    "$SUDO_BIN" "${cmd[@]}" >/dev/null
  else
    "${cmd[@]}" >/dev/null
  fi
}

real_path() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
  else
    # best effort fallback
    local dir
    dir="$(cd "$(dirname "$1")" 2>/dev/null && pwd)"
    printf '%s/%s\n' "${dir:-.}" "$(basename "$1")"
  fi
}

get_file_mtime() {
  if stat --version >/dev/null 2>&1; then
    stat -c %Y "$1"
  else
    stat -f %m "$1"
  fi
}

resolve_real_codex() {
  local self_real
  self_real="$(real_path "$0")"
  local prefer_paths=(
    /usr/local/bin/codex
    /opt/codex/bin/codex
  )
  local preferred=""
  for preferred in "${prefer_paths[@]}"; do
    if [[ -x "$preferred" ]]; then
      local preferred_real
      preferred_real="$(real_path "$preferred")"
      if [[ "$preferred_real" != "$self_real" ]]; then
        printf '%s' "$preferred_real"
        return 0
      fi
    fi
  done
  local found=""
  IFS=: read -r -a path_entries <<<"${PATH:-}"
  for entry in "${path_entries[@]}"; do
    [[ -z "$entry" ]] && entry="."
    local candidate="$entry/codex"
    [[ ! -x "$candidate" ]] && continue
    local candidate_real
    candidate_real="$(real_path "$candidate")"
    if [[ "$candidate_real" == "$self_real" ]]; then
      continue
    fi
    found="$candidate_real"
    break
  done
  if [[ -z "$found" && -x /usr/local/bin/codex ]]; then
    found="$(real_path /usr/local/bin/codex)"
  fi
  printf '%s' "$found"
}

normalize_version() {
  local v="$1"
  v="${v#codex-cli }"
  v="${v#codex }"
  v="${v#rust-}"
  v="${v#v}"
  printf '%s' "$v"
}

detect_glibc_version() {
  local version=""
  if command -v getconf >/dev/null 2>&1; then
    local gc
    gc="$(getconf GNU_LIBC_VERSION 2>/dev/null || true)"
    if [[ "$gc" =~ ([0-9]+\.[0-9]+) ]]; then
      version="${BASH_REMATCH[1]}"
    fi
  fi
  if [[ -z "$version" ]]; then
    if command -v ldd >/dev/null 2>&1; then
      local first
      first="$(ldd --version 2>&1 | head -n1)"
      if [[ "$first" =~ ([0-9]+\.[0-9]+) ]]; then
        version="${BASH_REMATCH[1]}"
      fi
    fi
  fi
  printf '%s' "$version"
}

version_lt() {
  local a="$1"
  local b="$2"
  [[ "$a" == "$b" ]] && return 1

  if command -v python3 >/dev/null 2>&1; then
    if python3 - "$a" "$b" <<'PY'; then
import re
import sys

def parse(value: str):
    parts = [int(token) for token in re.findall(r"\d+", value or "")]
    return parts if parts else [0]

left = parse(sys.argv[1])
right = parse(sys.argv[2])
width = max(len(left), len(right))
left += [0] * (width - len(left))
right += [0] * (width - len(right))
sys.exit(0 if left < right else 1)
PY
      return 0
    fi
    return 1
  fi

  if [[ "$a" < "$b" ]]; then
    return 0
  fi
  return 1
}

ssh_should_force_no_alt_screen() {
  case "$(lowercase "${CODEX_SSH_ALT_SCREEN:-auto}")" in
    0 | false | no | off)
      return 1
      ;;
    1 | true | yes | on | force)
      return 0
      ;;
  esac

  local local_version="${LOCAL_VERSION:-}"
  if [[ -n "$local_version" ]] && ! version_lt "$local_version" "0.117.0"; then
    return 1
  fi

  return 0
}

is_ssh_session() {
  [[ -n "${SSH_TTY:-}" || -n "${SSH_CONNECTION:-}" ]]
}

probe_latest_version_tag() {
  local url="${1:-https://github.com/openai/codex/releases/latest}"
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  local effective
  local curl_args=(-fsSLI -o /dev/null -w '%{url_effective}' -L)
  if [[ "${CODEX_FORCE_IPV4:-0}" == "1" ]]; then
    curl_args+=("-4")
  fi
  if ! effective="$(curl "${curl_args[@]}" "$url" 2>/dev/null)"; then
    return 1
  fi
  if [[ "$effective" =~ /tag/([^/]+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return 0
  fi
  return 1
}

require_python() {
  if ! activate_python3_shim; then
    log_warn "python3 is required for update checks; skipping update detection."
    return 1
  fi
  return 0
}

has_baked_sync_config() {
  local base_placeholder="__CODEX_SYNC_BASE""_URL__"
  local key_placeholder="__CODEX_SYNC_API""_KEY__"
  [[ -n "${CODEX_SYNC_BASE_URL_DEFAULT:-}" ]] \
    && [[ "${CODEX_SYNC_BASE_URL_DEFAULT}" != "$base_placeholder" ]] \
    && [[ -n "${CODEX_SYNC_API_KEY:-}" ]] \
    && [[ "${CODEX_SYNC_API_KEY}" != "$key_placeholder" ]]
}

load_sync_config() {
  if ((SYNC_CONFIG_LOADED)); then
    return 0
  fi
  local cred_file="${XDG_CONFIG_HOME:-$HOME/.config}/cdx/credentials.env"
  if has_baked_sync_config; then
    CODEX_SYNC_BASE_URL="${CODEX_SYNC_BASE_URL_DEFAULT%/}"
    log_debug "config (baked) | base=${CODEX_SYNC_BASE_URL} | api_key=$(mask_key "$CODEX_SYNC_API_KEY") | fqdn=${CODEX_SYNC_FQDN:-none} | ca=${CODEX_SYNC_CA_FILE:-none} | secure=${CODEX_HOST_SECURE}"
  elif [[ -f "$cred_file" ]]; then
    # CLI-login credentials are only a fallback for wrappers that were not baked for a host.
    # shellcheck source=/dev/null
    source "$cred_file"
    CODEX_SYNC_BASE_URL="${CODEX_SYNC_BASE_URL%/}"
    log_debug "config (credentials.env) | base=${CODEX_SYNC_BASE_URL} | api_key=$(mask_key "$CODEX_SYNC_API_KEY") | fqdn=${CODEX_SYNC_FQDN:-none}"
  else
    CODEX_SYNC_BASE_URL="${CODEX_SYNC_BASE_URL_DEFAULT%/}"
    log_debug "config (missing) | base=${CODEX_SYNC_BASE_URL} | api_key=$(mask_key "$CODEX_SYNC_API_KEY") | fqdn=${CODEX_SYNC_FQDN:-none} | ca=${CODEX_SYNC_CA_FILE:-none} | secure=${CODEX_HOST_SECURE}"
  fi
  enforce_baked_fqdn_guard
  SYNC_CONFIG_LOADED=1
}

detect_codex_asset_name() {
  local os_name arch_name
  os_name="$(uname -s 2>/dev/null || echo unknown)"
  arch_name="$(uname -m 2>/dev/null || echo unknown)"
  case "$os_name" in
    Linux)
      case "$arch_name" in
        x86_64 | amd64)
          local glibc_version
          glibc_version="$(detect_glibc_version)"
          if [[ -z "$glibc_version" ]] || version_lt "$glibc_version" "2.39"; then
            printf "codex-x86_64-unknown-linux-musl.tar.gz"
          else
            printf "codex-x86_64-unknown-linux-gnu.tar.gz"
          fi
          ;;
        aarch64 | arm64)
          printf "codex-aarch64-unknown-linux-gnu.tar.gz"
          ;;
        *)
          return 1
          ;;
      esac
      ;;
    Darwin)
      case "$arch_name" in
        x86_64 | amd64) printf "codex-x86_64-apple-darwin.tar.gz" ;;
        aarch64 | arm64) printf "codex-aarch64-apple-darwin.tar.gz" ;;
        *) return 1 ;;
      esac
      ;;
    *)
      return 1
      ;;
  esac
}

## --- CLI login (device-code flow) ---

save_cli_auth() {
  local api_key="$1" base_url="$2" fqdn="$3" secure="$4"
  local config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/cdx"
  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  cat >"$config_dir/credentials.env" <<CREDEOF
CODEX_SYNC_API_KEY=$api_key
CODEX_SYNC_BASE_URL=$base_url
CODEX_SYNC_FQDN=$fqdn
CODEX_HOST_SECURE=$secure
CREDEOF
  chmod 600 "$config_dir/credentials.env"
}

cmd_login() {
  local base_url="${CODEX_SYNC_BASE_URL_DEFAULT:-}"

  # If no baked base URL, prompt for it
  if [[ -z "$base_url" || "$base_url" == "__CODEX_SYNC_BASE_URL__" ]]; then
    # Check credentials.env for an existing base URL
    local cred_file="${XDG_CONFIG_HOME:-$HOME/.config}/cdx/credentials.env"
    if [[ -f "$cred_file" ]]; then
      # shellcheck source=/dev/null
      source "$cred_file"
      base_url="${CODEX_SYNC_BASE_URL:-}"
    fi
    if [[ -z "$base_url" || "$base_url" == "__CODEX_SYNC_BASE_URL__" ]]; then
      printf "Enter orchestrator URL: "
      read -r base_url
    fi
  fi
  base_url="${base_url%/}"

  if [[ -z "$base_url" ]]; then
    log_error "No orchestrator URL provided."
    exit 1
  fi

  local fqdn
  fqdn="$(hostname -f 2>/dev/null || hostname 2>/dev/null || echo unknown)"

  log_info "Starting CLI login for ${BOLD}${fqdn}${RESET}"

  local start_response
  start_response="$(python3 -c "
import json, urllib.request, urllib.error, sys, ssl
url = sys.argv[1] + '/cli/auth/start'
data = json.dumps({'fqdn': sys.argv[2]}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'}, method='POST')
try:
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
        print(resp.read().decode('utf-8'))
except urllib.error.HTTPError as e:
    body = e.read().decode('utf-8', 'ignore')
    print(json.dumps({'status': 'error', 'message': body}), file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print(json.dumps({'status': 'error', 'message': str(e)}), file=sys.stderr)
    sys.exit(1)
" "$base_url" "$fqdn" 2>&1)" || {
    log_error "Failed to initiate login."
    log_error "$start_response"
    exit 1
  }

  local request_id user_code verify_url expires_in poll_interval
  eval "$(python3 -c "
import json, sys, shlex
d = json.loads(sys.argv[1])['data']
print('request_id=' + shlex.quote(d['request_id']))
print('user_code=' + shlex.quote(d['user_code']))
print('verify_url=' + shlex.quote(d['verify_url']))
print('expires_in=' + shlex.quote(str(d['expires_in'])))
print('poll_interval=' + shlex.quote(str(d['poll_interval'])))
" "$start_response")"

  printf '\n'
  log_info "Open this URL in your browser:"
  printf '  %b%s%b\n\n' "${BOLD}${CYAN}" "$verify_url" "${RESET}"
  log_info "Then enter this code:"
  printf '  %b%s%b\n\n' "${BOLD}${CYAN}" "$user_code" "${RESET}"

  # Try to open browser (best effort)
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$verify_url" 2>/dev/null &
  elif command -v open >/dev/null 2>&1; then
    open "$verify_url" 2>/dev/null &
  fi

  log_info "Waiting for approval..."

  local deadline=$((SECONDS + expires_in))
  while ((SECONDS < deadline)); do
    sleep "$poll_interval"

    local poll_response poll_status
    poll_response="$(python3 -c "
import json, urllib.request, urllib.error, sys, ssl
url = sys.argv[1] + '/cli/auth/poll/' + sys.argv[2]
req = urllib.request.Request(url, data=b'', headers={'Content-Type': 'application/json'}, method='POST')
try:
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=15, context=ctx) as resp:
        print(resp.read().decode('utf-8'))
except Exception:
    print(json.dumps({'data': {'status': 'pending'}}))
" "$base_url" "$request_id" 2>/dev/null)" || continue

    poll_status="$(python3 -c "
import json, sys
d = json.loads(sys.argv[1])
print(d.get('data', {}).get('status', 'error'))
" "$poll_response" 2>/dev/null)" || continue

    case "$poll_status" in
      approved)
        eval "$(python3 -c "
import json, sys, shlex
d = json.loads(sys.argv[1])['data']
print('CLI_API_KEY=' + shlex.quote(d['api_key']))
print('CLI_BASE_URL=' + shlex.quote(d['base_url']))
print('CLI_FQDN=' + shlex.quote(d['fqdn']))
secure = '1' if d.get('secure', True) else '0'
print('CLI_SECURE=' + shlex.quote(secure))
" "$poll_response")"

        save_cli_auth "$CLI_API_KEY" "$CLI_BASE_URL" "$CLI_FQDN" "$CLI_SECURE"
        printf '\n'
        log_info "Authenticated successfully as ${BOLD}${CLI_FQDN}${RESET}"
        exit 0
        ;;
      denied)
        printf '\n'
        log_error "Login request was denied."
        exit 1
        ;;
      expired)
        printf '\n'
        log_error "Login request expired. Run 'cdx login' to try again."
        exit 1
        ;;
      pending) ;;
    esac
  done

  log_error "Login timed out. Run 'cdx login' to try again."
  exit 1
}

if ((CODEX_DO_LOGIN)); then
  cmd_login
fi

if ((CODEX_DO_UNINSTALL)); then
  cmd_uninstall
fi
