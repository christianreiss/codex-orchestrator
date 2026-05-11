# ── CLX Boot Screen (summary display) ─────────────────────────
# Neofetch-style boot banner showing health, versions, usage, and quota.

print_boot_screen() {
  ((CLAUDE_SILENT)) && return 0

  local claude_cli=""
  claude_cli="$(detect_claude_cli || true)"
  local claude_ver="unknown"
  if [[ -n "$claude_cli" ]]; then
    claude_ver="$("$claude_cli" --version 2>/dev/null | head -1 || echo "unknown")"
  fi
  local claude_ver_inst=""
  claude_ver_inst="$(extract_version_token "$claude_ver")"
  [[ -z "$claude_ver_inst" ]] && claude_ver_inst="$claude_ver"

  # Determine tones for the banner info lines.
  local claude_tone="green"
  local wrapper_tone="green"
  local api_tone="yellow"
  local auth_tone="yellow"
  local skill_tone="green"
  local config_tone="green"

  # Single /versions probe for both API health and quota data.
  local versions_resp=""
  if [[ -n "$CLAUDE_SYNC_BASE_URL" ]] && [[ -n "$CLAUDE_SYNC_API_KEY" ]]; then
    versions_resp="$(clx_curl "${CLAUDE_SYNC_BASE_URL}/versions" 2>/dev/null || true)"
    if [[ -n "$versions_resp" ]]; then
      api_tone="green"
    else
      api_tone="red"
    fi
  fi

  # Auth status.
  if [[ -f "$CLX_AUTH_FILE" ]]; then
    auth_tone="green"
  else
    auth_tone="red"
  fi

  # Claude CLI availability.
  if [[ -z "$claude_cli" ]]; then
    claude_tone="red"
  fi

  # Settings / CLAUDE.md presence.
  if [[ ! -f "${CLX_SETTINGS_FILE:-}" ]]; then
    config_tone="yellow"
  fi

  # ── Info panel (alongside banner) ──
  local show_banner=1
  ((CLAUDE_SKIP_MOTD)) && show_banner=0

  if ((show_banner)); then
    local info=()
    local sep_char="─"
    output_supports_unicode || sep_char="-"
    local dot_sep
    printf -v dot_sep "%b·%b" "${DIM}" "${RESET}"

    # L0: empty
    info+=("")

    # L1: title
    local title
    title="$(colorize "claude orchestrator" "$(banner_color_tone)")"
    info+=("$title")

    # L2: tagline
    local tagline
    printf -v tagline "%bClaude go brrrr!%b" "${DIM}" "${RESET}"
    info+=("$tagline")

    # L3: separator
    local sep_line=""
    local si
    for ((si = 0; si < 25; si++)); do sep_line+="$sep_char"; done
    printf -v sep_line "%b%s%b" "${DIM}" "$sep_line" "${RESET}"
    info+=("$sep_line")

    # L4: Claude CLI version
    local cli_ver_colored
    cli_ver_colored="$(colorize "$claude_ver_inst" "$claude_tone")"
    local cli_line="claude   ${cli_ver_colored}"
    info+=("$cli_line")

    # L5: wrapper version
    local wrap_ver="${WRAPPER_VERSION:-unknown}"
    local wrap_ver_colored
    wrap_ver_colored="$(colorize "$wrap_ver" "$wrapper_tone")"
    local wrap_line="wrapper  ${wrap_ver_colored}"
    info+=("$wrap_line")

    # L6: context line
    local ctx_parts=()
    if ((!HOST_IS_SECURE)); then
      local lock_icon="🔓"
      output_supports_unicode || lock_icon="[!]"
      ctx_parts+=("$(colorize "${lock_icon} insecure" "yellow")")
    fi
    if [[ -n "${CLAUDE_HOST_MODEL:-}" ]]; then
      ctx_parts+=("$CLAUDE_HOST_MODEL")
    fi
    local ctx_line="" cp
    for cp in "${ctx_parts[@]}"; do
      [[ -z "$cp" ]] && continue
      [[ -n "$ctx_line" ]] && ctx_line+=" ${dot_sep} "
      ctx_line+="$cp"
    done
    info+=("$ctx_line")

    print_boot_banner "${info[@]}"
  fi

  # ── Health dots ──
  local dots="" dot_gap="  "
  dots+="$(build_health_dot "api" "$api_tone")"
  dots+="${dot_gap}$(build_health_dot "auth" "$auth_tone")"
  dots+="${dot_gap}$(build_health_dot "skills" "$skill_tone")"
  dots+="${dot_gap}$(build_health_dot "config" "$config_tone")"

  printf "\n  %s\n" "$dots"

}
