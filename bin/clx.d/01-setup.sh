# ── CLX Setup & Dependencies ──────────────────────────────────

detect_linux_package_manager() {
  if command -v apt-get >/dev/null 2>&1; then printf 'apt-get'; return 0; fi
  if command -v dnf >/dev/null 2>&1; then printf 'dnf'; return 0; fi
  if command -v yum >/dev/null 2>&1; then printf 'yum'; return 0; fi
  if command -v pacman >/dev/null 2>&1; then printf 'pacman'; return 0; fi
  if command -v apk >/dev/null 2>&1; then printf 'apk'; return 0; fi
  if command -v zypper >/dev/null 2>&1; then printf 'zypper'; return 0; fi
  return 1
}

install_claude_cli() {
  log_info "Installing Claude Code CLI..."
  if command -v npm >/dev/null 2>&1; then
    npm install -g @anthropic-ai/claude-code 2>/dev/null && return 0
  fi
  if command -v npx >/dev/null 2>&1; then
    log_info "npm global install failed; will use npx at runtime."
    return 0
  fi
  log_error "Cannot install Claude Code CLI: npm not found."
  log_error "Install Node.js (>= 18) and npm, then retry."
  return 1
}

ensure_claude_cli() {
  if command -v claude >/dev/null 2>&1; then
    log_debug "Claude Code CLI found: $(command -v claude)"
    return 0
  fi
  if command -v claude-code >/dev/null 2>&1; then
    log_debug "Claude Code CLI found: $(command -v claude-code)"
    return 0
  fi
  install_claude_cli
}

ensure_deps() {
  local -a missing=()
  command -v curl >/dev/null 2>&1 || missing+=(curl)
  command -v jq >/dev/null 2>&1 || missing+=(jq)

  if ((${#missing[@]} > 0)); then
    log_info "Missing dependencies: ${missing[*]}"
    local os
    os="$(uname -s)"
    case "$os" in
      Darwin)
        if command -v brew >/dev/null 2>&1; then
          brew install "${missing[@]}" || true
        fi
        ;;
      Linux)
        local pm=""
        pm="$(detect_linux_package_manager || true)"
        if [[ -n "$pm" ]]; then
          local use_sudo=()
          ((EUID != 0)) && command -v sudo >/dev/null 2>&1 && use_sudo=(sudo)
          case "$pm" in
            apt-get) "${use_sudo[@]}" apt-get update -qq && "${use_sudo[@]}" apt-get install -y "${missing[@]}" ;;
            dnf)     "${use_sudo[@]}" dnf install -y "${missing[@]}" ;;
            yum)     "${use_sudo[@]}" yum install -y "${missing[@]}" ;;
            pacman)  "${use_sudo[@]}" pacman -S --noconfirm "${missing[@]}" ;;
            apk)     "${use_sudo[@]}" apk add "${missing[@]}" ;;
            zypper)  "${use_sudo[@]}" zypper install -y "${missing[@]}" ;;
          esac
        fi
        ;;
    esac
  fi

  # Ensure Claude Code CLI itself.
  ensure_claude_cli
}

# ── Data directories ──────────────────────────────────────────
CLX_DATA_DIR="${CLX_DATA_DIR:-${HOME}/.clx}"
CLX_CACHE_DIR="${CLX_DATA_DIR}/cache"
CLX_AUTH_DIR="${CLX_DATA_DIR}/auth"
CLX_CONFIG_DIR="${CLX_DATA_DIR}/config"
CLX_SKILLS_DIR="${CLX_DATA_DIR}/skills"

mkdir -p "$CLX_DATA_DIR" "$CLX_CACHE_DIR" "$CLX_AUTH_DIR" "$CLX_CONFIG_DIR" "$CLX_SKILLS_DIR" 2>/dev/null || true
