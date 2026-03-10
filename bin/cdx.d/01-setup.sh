
ensure_commands() {
  local missing=()
  local cmd
  for cmd in "$@"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if (( ${#missing[@]} == 0 )); then
    return 0
  fi

  local os=""
  os="$(uname -s)"
  case "$os" in
    Darwin)
      if ! command -v brew >/dev/null 2>&1; then
        log_error "Missing required commands: ${missing[*]}. Install Homebrew (brew) or add them manually."
        exit 1
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
      brew install "${brew_missing[@]}"
      ;;
    Linux)
      local pm=""
      if ! pm="$(detect_linux_package_manager)"; then
        log_error "Missing required commands: ${missing[*]}. Unable to determine package manager for automatic installation."
        exit 1
      fi

      local use_sudo=()
      if (( EUID != 0 )); then
        if command -v sudo >/dev/null 2>&1; then
          use_sudo=(sudo)
        else
          log_error "Missing required commands: ${missing[*]}. Install them manually or rerun Codex as root to allow automatic installation."
          exit 1
        fi
      fi

      local install_missing=()
      local dep pkg
      for dep in "${missing[@]}"; do
        pkg="$dep"
        case "$pm:$dep" in
          pacman:python3)
            pkg="python"
            ;;
          pacman:script|apk:script|dnf:script|yum:script)
            pkg="util-linux"
            ;;
        esac
        install_missing+=("$pkg")
      done

      case "$pm" in
        apt-get)
          log_info "Installing prerequisites (${missing[*]}) with apt-get"
          if (( ${#use_sudo[@]} > 0 )); then
            "${use_sudo[@]}" apt-get update -qq
            "${use_sudo[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${install_missing[@]}"
          else
            apt-get update -qq
            DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${install_missing[@]}"
          fi
          ;;
        dnf)
          log_info "Installing prerequisites (${missing[*]}) with dnf"
          if (( ${#use_sudo[@]} > 0 )); then
            "${use_sudo[@]}" dnf install -y "${install_missing[@]}"
          else
            dnf install -y "${install_missing[@]}"
          fi
          ;;
        yum)
          log_info "Installing prerequisites (${missing[*]}) with yum"
          if (( ${#use_sudo[@]} > 0 )); then
            "${use_sudo[@]}" yum install -y "${install_missing[@]}"
          else
            yum install -y "${install_missing[@]}"
          fi
          ;;
        pacman)
          log_info "Installing prerequisites (${missing[*]}) with pacman"
          if (( ${#use_sudo[@]} > 0 )); then
            "${use_sudo[@]}" pacman -S --noconfirm --needed "${install_missing[@]}"
          else
            pacman -S --noconfirm --needed "${install_missing[@]}"
          fi
          ;;
        zypper)
          log_info "Installing prerequisites (${missing[*]}) with zypper"
          if (( ${#use_sudo[@]} > 0 )); then
            "${use_sudo[@]}" zypper --non-interactive install --no-recommends "${install_missing[@]}"
          else
            zypper --non-interactive install --no-recommends "${install_missing[@]}"
          fi
          ;;
        apk)
          log_info "Installing prerequisites (${missing[*]}) with apk"
          if (( ${#use_sudo[@]} > 0 )); then
            "${use_sudo[@]}" apk add --no-cache "${install_missing[@]}"
          else
            apk add --no-cache "${install_missing[@]}"
          fi
          ;;
        *)
          log_error "Unsupported package manager: ${pm}"
          exit 1
          ;;
      esac
      ;;
    *)
      log_error "Missing required commands: ${missing[*]}. Automatic installation is only supported on Linux or macOS with Homebrew."
      exit 1
      ;;
  esac

  local still_missing=()
  for cmd in "${missing[@]}"; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      still_missing+=("$cmd")
    fi
  done

  if (( ${#still_missing[@]} > 0 )); then
    log_error "Failed to install required commands: ${still_missing[*]}"
    exit 1
  fi
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

  if (( EUID == 0 )); then
    "${cmd[@]}" >/dev/null
  elif (( CAN_SUDO )); then
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
  IFS=: read -r -a path_entries <<< "${PATH:-}"
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
    if python3 - "$a" "$b" <<'PY'
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
    then
      return 0
    fi
    return 1
  fi

  if [[ "$a" < "$b" ]]; then
    return 0
  fi
  return 1
}

is_ssh_session() {
  [[ -n "${SSH_TTY:-}" || -n "${SSH_CONNECTION:-}" ]]
}

codex_ssh_regression_fallback_version() {
  local version
  version="$(normalize_version "${1-}")"
  case "$version" in
    0.113.0)
      printf '0.112.0'
      ;;
  esac
}

codex_ssh_regression_reason() {
  local version
  version="$(normalize_version "${1-}")"
  case "$version" in
    0.113.0)
      printf 'prompt submission can hang in plain SSH terminals'
      ;;
  esac
}

probe_latest_version_tag() {
  local url="${1:-https://github.com/openai/codex/releases/latest}"
  if ! command -v curl >/dev/null 2>&1; then
    return 1
  fi
  local effective
  local curl_args=(-fsSLI -o /dev/null -w '%{url_effective}' -L)
  if [[ "$CODEX_FORCE_IPV4" == "1" ]]; then
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
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 is required for update checks; skipping update detection."
    return 1
  fi
  return 0
}

load_sync_config() {
  if (( SYNC_CONFIG_LOADED )); then
    return 0
  fi
  # Always prefer baked-in sync configuration; ignore local .env overrides.
  CODEX_SYNC_BASE_URL="${CODEX_SYNC_BASE_URL_DEFAULT%/}"
  log_debug "config (baked-only) | base=${CODEX_SYNC_BASE_URL} | api_key=$(mask_key "$CODEX_SYNC_API_KEY") | fqdn=${CODEX_SYNC_FQDN:-none} | ca=${CODEX_SYNC_CA_FILE:-none} | secure=${CODEX_HOST_SECURE}"
  enforce_baked_fqdn_guard
  SYNC_CONFIG_LOADED=1
}

if (( CODEX_DO_UNINSTALL )); then
  cmd_uninstall
fi
