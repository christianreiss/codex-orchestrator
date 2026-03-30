if ((!HOST_IS_SECURE)); then
  if ((insecure_compact_ok)); then
    result_label="Synced on insecure host; auth refreshed."
  elif [[ "$result_tone" == "green" ]]; then
    result_label="Ready on insecure host."
  fi
elif [[ "$result_tone" == "green" && "$command_tone" != "red" && "$auth_tone" == "green" && "$codex_tone" == "green" && "$wrapper_tone" == "green" ]]; then
  result_label="Ready (Codex go brrrr)."
fi

# Prefer an ASCII-friendly table (no box drawing). The "card" style divider
# and bullet header proved fragile across terminals/fonts.
SUMMARY_STYLE="${CDX_SUMMARY_STYLE:-table}"

lane_requested=""
CODEX_EFFECTIVE_LANE_SOURCE=""
if [[ "$CODEX_LANE_TARGET" == "normal" || "$CODEX_LANE_TARGET" == "spark" ]]; then
  lane_requested="$CODEX_LANE_TARGET"
  CODEX_EFFECTIVE_LANE_SOURCE="command"
elif [[ "$HOST_LANE_PREFERENCE" == "normal" || "$HOST_LANE_PREFERENCE" == "spark" ]]; then
  lane_requested="$HOST_LANE_PREFERENCE"
  CODEX_EFFECTIVE_LANE_SOURCE="host"
elif [[ "$(lowercase "$CHATGPT_ACTIVE_LANE")" == "spark" ]]; then
  lane_requested="spark"
  CODEX_EFFECTIVE_LANE_SOURCE="api"
else
  lane_requested="normal"
  CODEX_EFFECTIVE_LANE_SOURCE="api"
fi

has_spark_lane=0
if [[ -n "$CHATGPT_SPARK_PRIMARY_USED" || -n "$CHATGPT_SPARK_PRIMARY_LIMIT" || -n "$CHATGPT_SPARK_SECONDARY_USED" || -n "$CHATGPT_SPARK_SECONDARY_LIMIT" ]]; then
  has_spark_lane=1
fi
CODEX_EFFECTIVE_LANE="$lane_requested"
if [[ "$CODEX_EFFECTIVE_LANE" == "spark" && "$has_spark_lane" != "1" ]]; then
  CODEX_EFFECTIVE_LANE="normal"
  if [[ -n "$CODEX_EFFECTIVE_LANE_SOURCE" ]]; then
    CODEX_EFFECTIVE_LANE_SOURCE="${CODEX_EFFECTIVE_LANE_SOURCE}:fallback"
  else
    CODEX_EFFECTIVE_LANE_SOURCE="fallback"
  fi
fi
if [[ "$CODEX_EFFECTIVE_LANE" != "spark" && "$CODEX_EFFECTIVE_LANE" != "normal" ]]; then
  CODEX_EFFECTIVE_LANE="normal"
fi

CHATGPT_ACTIVE_LANE="$CODEX_EFFECTIVE_LANE"
if [[ "$CODEX_EFFECTIVE_LANE" == "spark" ]]; then
  CHATGPT_PRIMARY_USED="$CHATGPT_SPARK_PRIMARY_USED"
  CHATGPT_PRIMARY_LIMIT="$CHATGPT_SPARK_PRIMARY_LIMIT"
  CHATGPT_PRIMARY_RESET_AFTER="$CHATGPT_SPARK_PRIMARY_RESET_AFTER"
  CHATGPT_PRIMARY_RESET_AT="$CHATGPT_SPARK_PRIMARY_RESET_AT"
  CHATGPT_SECONDARY_USED="$CHATGPT_SPARK_SECONDARY_USED"
  CHATGPT_SECONDARY_LIMIT="$CHATGPT_SPARK_SECONDARY_LIMIT"
  CHATGPT_SECONDARY_RESET_AFTER="$CHATGPT_SPARK_SECONDARY_RESET_AFTER"
  CHATGPT_SECONDARY_RESET_AT="$CHATGPT_SPARK_SECONDARY_RESET_AT"
else
  CHATGPT_PRIMARY_USED="$CHATGPT_NORMAL_PRIMARY_USED"
  CHATGPT_PRIMARY_LIMIT="$CHATGPT_NORMAL_PRIMARY_LIMIT"
  CHATGPT_PRIMARY_RESET_AFTER="$CHATGPT_NORMAL_PRIMARY_RESET_AFTER"
  CHATGPT_PRIMARY_RESET_AT="$CHATGPT_NORMAL_PRIMARY_RESET_AT"
  CHATGPT_SECONDARY_USED="$CHATGPT_NORMAL_SECONDARY_USED"
  CHATGPT_SECONDARY_LIMIT="$CHATGPT_NORMAL_SECONDARY_LIMIT"
  CHATGPT_SECONDARY_RESET_AFTER="$CHATGPT_NORMAL_SECONDARY_RESET_AFTER"
  CHATGPT_SECONDARY_RESET_AT="$CHATGPT_NORMAL_SECONDARY_RESET_AT"
fi

quota_limit="$QUOTA_LIMIT_PERCENT"
if [[ ! "$quota_limit" =~ ^[0-9]+$ ]]; then
  quota_limit=100
fi
if ((quota_limit < 50)); then
  quota_limit=50
elif ((quota_limit > 100)); then
  quota_limit=100
fi
QUOTA_LIMIT_PERCENT="$quota_limit"

quota_lane_label="normal"
if [[ "$(lowercase "$CHATGPT_ACTIVE_LANE")" == "spark" ]]; then
  quota_lane_label="spark"
fi
quota_lane_display="${quota_lane_label}"
if [[ "$quota_lane_display" == "spark" ]]; then
  if output_supports_unicode; then
    quota_lane_display="${quota_lane_display} ⚡︎"
  else
    quota_lane_display="${quota_lane_display} (fast)"
  fi
fi
if [[ "$quota_lane_label" == "spark" && -n "$CHATGPT_SPARK_LIMIT_NAME" ]]; then
  quota_lane_display="${quota_lane_display} (${CHATGPT_SPARK_LIMIT_NAME})"
fi

partition_days="$QUOTA_WEEK_PARTITION"
if [[ ! "$partition_days" =~ ^[0-9]+$ ]]; then
  partition_days=0
fi
if ((partition_days != 5 && partition_days != 7)); then
  partition_days=0
fi
QUOTA_WEEK_PARTITION="$partition_days"

bullet="$(section_bullet)"
health_rows=()
api_state="reachable"
if [[ "$api_tone" != "green" ]]; then
  api_state="${api_label:-unreachable}"
  api_state="$(colorize "$api_state" "$api_tone")"
fi
health_rows+=("${bullet} API: ${api_state}")

auth_state="synced"
if [[ "$auth_tone" != "green" ]]; then
  auth_state="${auth_label:-needs attention}"
  auth_state="$(colorize "$auth_state" "$auth_tone")"
fi
health_rows+=("${bullet} Auth: ${auth_state}")

skill_state="in sync"
if [[ "$skill_tone" == "green" ]]; then
  if [[ "$skill_label" =~ local[[:space:]]+([0-9]+).*remote[[:space:]]+([0-9]+) ]]; then
    skill_state="in sync (${BASH_REMATCH[1]}/${BASH_REMATCH[2]})"
  fi
else
  skill_state="${skill_label:-needs attention}"
  skill_state="$(colorize "$skill_state" "$skill_tone")"
fi
health_rows+=("${bullet} Skills: ${skill_state}")

if [[ -n "$runner_label" ]]; then
  runner_state="healthy"
  if [[ "$runner_tone" != "green" ]]; then
    runner_state="$(colorize "$runner_label" "$runner_tone")"
  fi
  health_rows+=("${bullet} Runner: ${runner_state}")
fi

# MCP status (managed codex-orchestrator server in config.toml).
mcp_tone=""
if [[ -f "$CONFIG_PATH" ]]; then
  mcp_tone="yellow"
  if toml_table_enabled "$CONFIG_PATH" "mcp_servers.cdx"; then
    mcp_tone="green"
  else
    case $? in
      1) mcp_tone="yellow" ;; # explicitly disabled
      2)
        if toml_table_enabled "$CONFIG_PATH" "mcp_servers.codex-orchestrator"; then
          mcp_tone="green"
        else
          mcp_tone="yellow"
        fi
        ;;
    esac
  fi
  mcp_state="enabled"
  if [[ "$mcp_tone" != "green" ]]; then
    mcp_state="$(colorize "disabled or not configured" "$mcp_tone")"
  fi
  health_rows+=("${bullet} MCP: ${mcp_state}")
fi

if ((QUOTA_HARD_FAIL)); then
  policy_state="deny launches at >=${quota_limit}%"
else
  policy_state="warn at >=${quota_limit}%"
fi
health_rows+=("${bullet} Quota policy: ${policy_state}")

version_rows=()
codex_ver_inst="$(extract_version_token "$codex_installed_display")"
codex_ver_target="$(extract_version_token "$codex_target_display")"
codex_ver_line="${codex_ver_inst:-${codex_installed_display:-unknown}}"
if [[ -n "$codex_ver_target" && "$codex_ver_target" != "$codex_ver_inst" ]]; then
  codex_ver_line+=" -> ${codex_ver_target}"
fi
if [[ "$codex_tone" == "green" ]]; then
  codex_ver_line+=" (current)"
else
  codex_ver_line+=" ($(colorize "${codex_status_display:-needs attention}" "$codex_tone"))"
fi
version_rows+=("${bullet} Codex: ${codex_ver_line}")

wrapper_ver_inst="$(extract_version_token "$wrapper_installed_display")"
wrapper_ver_target="$(extract_version_token "$wrapper_target_display")"
wrapper_ver_line="${wrapper_ver_inst:-${wrapper_installed_display:-unknown}}"
if [[ -n "$wrapper_ver_target" && "$wrapper_ver_target" != "$wrapper_ver_inst" ]]; then
  wrapper_ver_line+=" -> ${wrapper_ver_target}"
fi
if [[ "$wrapper_tone" == "green" ]]; then
  wrapper_ver_line+=" (current)"
else
  wrapper_ver_line+=" ($(colorize "${wrapper_status_display:-needs attention}" "$wrapper_tone"))"
fi
version_rows+=("${bullet} Wrapper: ${wrapper_ver_line}")

if [[ -n "$agents_label" ]]; then
  agents_state="synced"
  if [[ "$agents_tone" != "green" ]]; then
    agents_state="$(colorize "$agents_label" "$agents_tone")"
  fi
  version_rows+=("${bullet} AGENTS.md: ${agents_state}")
fi
if [[ -n "$config_label" ]]; then
  config_state="synced"
  if [[ "$config_tone" != "green" ]]; then
    config_state="$(colorize "$config_label" "$config_tone")"
  fi
  version_rows+=("${bullet} config.toml: ${config_state}")
fi

usage_rows=()
if [[ "$HOST_API_CALLS" =~ ^[0-9]+$ ]]; then
  usage_rows+=("${bullet} API calls (host total): $(format_grouped_int "$HOST_API_CALLS")")
fi
if [[ "$HOST_TOKENS_MONTH_TOTAL" =~ ^[0-9]+$ ]]; then
  usage_rows+=("${bullet} Tokens this month: $(format_grouped_int "$HOST_TOKENS_MONTH_TOTAL")")
elif [[ -n "$HOST_TOKENS_MONTH_TOTAL" ]]; then
  usage_rows+=("${bullet} Tokens this month: ${HOST_TOKENS_MONTH_TOTAL}")
fi
if [[ -n "$usage_summary" ]]; then
  usage_rows+=("${bullet} Latest run: ${usage_summary}")
fi
if ((${#usage_rows[@]} == 0)); then
  usage_rows+=("${bullet} No host usage data reported yet.")
fi

result_line="$(colorize "$result_label" "$result_tone")"
if [[ "${HOST_VIP:-0}" == "1" ]]; then
  if output_supports_unicode; then
    result_line+=" 👑"
  else
    result_line+=" (VIP)"
  fi
fi
lane_prefix=""
if [[ "$quota_lane_label" == "spark" ]]; then
  lane_prefix="spark "
fi

other_lane_label=""
other_lane_primary_used=""
other_lane_primary_limit=""
other_lane_primary_reset_after=""
other_lane_primary_reset_at=""
other_lane_secondary_used=""
other_lane_secondary_limit=""
other_lane_secondary_reset_after=""
other_lane_secondary_reset_at=""
if [[ "$quota_lane_label" == "spark" ]]; then
  other_lane_label="Normal"
  other_lane_primary_used="$CHATGPT_NORMAL_PRIMARY_USED"
  other_lane_primary_limit="$CHATGPT_NORMAL_PRIMARY_LIMIT"
  other_lane_primary_reset_after="$CHATGPT_NORMAL_PRIMARY_RESET_AFTER"
  other_lane_primary_reset_at="$CHATGPT_NORMAL_PRIMARY_RESET_AT"
  other_lane_secondary_used="$CHATGPT_NORMAL_SECONDARY_USED"
  other_lane_secondary_limit="$CHATGPT_NORMAL_SECONDARY_LIMIT"
  other_lane_secondary_reset_after="$CHATGPT_NORMAL_SECONDARY_RESET_AFTER"
  other_lane_secondary_reset_at="$CHATGPT_NORMAL_SECONDARY_RESET_AT"
else
  other_lane_label="Spark"
  other_lane_primary_used="$CHATGPT_SPARK_PRIMARY_USED"
  other_lane_primary_limit="$CHATGPT_SPARK_PRIMARY_LIMIT"
  other_lane_primary_reset_after="$CHATGPT_SPARK_PRIMARY_RESET_AFTER"
  other_lane_primary_reset_at="$CHATGPT_SPARK_PRIMARY_RESET_AT"
  other_lane_secondary_used="$CHATGPT_SPARK_SECONDARY_USED"
  other_lane_secondary_limit="$CHATGPT_SPARK_SECONDARY_LIMIT"
  other_lane_secondary_reset_after="$CHATGPT_SPARK_SECONDARY_RESET_AFTER"
  other_lane_secondary_reset_at="$CHATGPT_SPARK_SECONDARY_RESET_AT"
fi

other_lane_primary_quota_segment=""
other_lane_secondary_quota_segment=""
if [[ -n "$other_lane_primary_used" || -n "$other_lane_secondary_used" ]]; then
  qline=$(render_quota_line "$other_lane_primary_used" "$other_lane_primary_reset_after" "$other_lane_primary_reset_at")
  if [[ -n "$qline" ]]; then
    other_qtone="${qline%%$'\t'*}"
    other_rest="${qline#*$'\t'}"
    other_qtext="${other_rest%%$'\t'*}"
    other_qnote="${other_rest#*$'\t'}"
    other_qnote_disp="$other_qnote"
    if [[ -n "$other_qnote_disp" ]]; then
      printf -v other_qnote_disp "%b" "${DIM}${other_qnote_disp}${RESET}"
    fi
    other_lane_primary_quota_segment="$(colorize "$other_qtext" "$other_qtone")"
    if [[ -n "$other_qnote_disp" ]]; then
      other_lane_primary_quota_segment+=" ${other_qnote_disp}"
    fi
  fi

  qline=$(render_quota_line "$other_lane_secondary_used" "$other_lane_secondary_reset_after" "$other_lane_secondary_reset_at")
  if [[ -n "$qline" ]]; then
    other_qtone2="${qline%%$'\t'*}"
    other_rest2="${qline#*$'\t'}"
    other_qtext2="${other_rest2%%$'\t'*}"
    other_qnote2="${other_rest2#*$'\t'}"
    other_projection_note=""
    other_projection_alert=0
    other_projection_pct="$(project_quota_usage "$other_lane_secondary_used" "$other_lane_secondary_limit" "$other_lane_secondary_reset_after" || true)"
    if [[ -n "$other_projection_pct" ]]; then
      if ((other_projection_pct >= 100)); then
        other_projection_eta="$(project_quota_hit_eta "$other_lane_secondary_used" "$other_lane_secondary_limit" "$other_lane_secondary_reset_after" || true)"
        if [[ -n "$other_projection_eta" ]]; then
          other_projection_note="(hits 100 in ~${other_projection_eta}, before reset)"
        else
          other_projection_note="proj 100% at reset"
        fi
        other_projection_alert=1
      else
        other_projection_note="proj ~${other_projection_pct}% at reset"
      fi
    fi
    other_qnote_full="$(join_with_semicolon "$other_qnote2" "$other_projection_note")"
    other_qnote2_disp="$other_qnote_full"
    if [[ -n "$other_qnote2_disp" ]]; then
      if ((other_projection_alert)); then
        printf -v other_qnote2_disp "%b" "${RED}${BOLD}${other_qnote2_disp}${RESET}"
      else
        printf -v other_qnote2_disp "%b" "${DIM}${other_qnote2_disp}${RESET}"
      fi
    fi
    other_lane_secondary_quota_segment="$(colorize "$other_qtext2" "$other_qtone2")"
    if [[ -n "$other_qnote2_disp" ]]; then
      other_lane_secondary_quota_segment+=" ${other_qnote2_disp}"
    fi
  fi
fi
primary_reset_hint=""
primary_quota_segment=""
qline=$(render_quota_line "$CHATGPT_PRIMARY_USED" "$CHATGPT_PRIMARY_RESET_AFTER" "$CHATGPT_PRIMARY_RESET_AT")
if [[ -n "$qline" ]]; then
  qtone="${qline%%$'\t'*}"
  rest="${qline#*$'\t'}"
  qtext="${rest%%$'\t'*}"
  qnote="${rest#*$'\t'}"
  primary_reset_hint="$qnote"
  qnote_disp="$qnote"
  if [[ -n "$qnote_disp" ]]; then
    printf -v qnote_disp "%b" "${DIM}${qnote_disp}${RESET}"
  fi
  # qtext looks like "  7% [bars]"
  primary_quota_segment="$(colorize "$qtext" "$qtone")"
  if [[ -n "$qnote_disp" ]]; then
    primary_quota_segment+=" ${qnote_disp}"
  fi
fi

secondary_reset_hint=""
secondary_quota_segment=""
qline=$(render_quota_line "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_RESET_AFTER" "$CHATGPT_SECONDARY_RESET_AT")
if [[ -n "$qline" ]]; then
  qtone2="${qline%%$'\t'*}"
  rest2="${qline#*$'\t'}"
  qtext2="${rest2%%$'\t'*}"
  qnote2="${rest2#*$'\t'}"
  projection_note=""
  projection_alert=0
  projection_pct="$(project_quota_usage "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_LIMIT" "$CHATGPT_SECONDARY_RESET_AFTER" || true)"
  if [[ -n "$projection_pct" ]]; then
    if ((projection_pct >= 100)); then
      projection_eta="$(project_quota_hit_eta "$CHATGPT_SECONDARY_USED" "$CHATGPT_SECONDARY_LIMIT" "$CHATGPT_SECONDARY_RESET_AFTER" || true)"
      if [[ -n "$projection_eta" ]]; then
        projection_note="(hits 100 in ~${projection_eta}, before reset)"
      else
        projection_note="proj 100% at reset"
      fi
      projection_alert=1
    else
      projection_note="proj ~${projection_pct}% at reset"
    fi
  fi
  qnote_full="$(join_with_semicolon "$qnote2" "$projection_note")"
  secondary_reset_hint="$qnote_full"
  qnote2_disp="$qnote_full"
  if [[ -n "$qnote2_disp" ]]; then
    if ((projection_alert)); then
      printf -v qnote2_disp "%b" "${RED}${BOLD}${qnote2_disp}${RESET}"
    else
      printf -v qnote2_disp "%b" "${DIM}${qnote2_disp}${RESET}"
    fi
  fi
  secondary_quota_segment="$(colorize "$qtext2" "$qtone2")"
  if [[ -n "$qnote2_disp" ]]; then
    secondary_quota_segment+=" ${qnote2_disp}"
  fi
fi

daily_quota_segment=""
daily_reset_hint=""
daily_allowance_used_pct=""
if ((QUOTA_WEEK_PARTITION == 5 || QUOTA_WEEK_PARTITION == 7)); then
  if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
    partition_days="$QUOTA_WEEK_PARTITION"
    allowance_per_day=$(((100 + partition_days / 2) / partition_days))
    ((allowance_per_day < 1)) && allowance_per_day=1
    daily_used="${CHATGPT_DAILY_USED:-}"
    if [[ "$daily_used" =~ ^[0-9]+$ ]]; then
      bar_pct=$(((daily_used * 100 + allowance_per_day / 2) / allowance_per_day))
      ((bar_pct < 0)) && bar_pct=0
      ((bar_pct > 999)) && bar_pct=999
      daily_allowance_used_pct=$bar_pct
      bar_display=$bar_pct
      ((bar_display > 100)) && bar_display=100
      bar="$(build_quota_bar "$bar_display" "$QUOTA_BAR_WIDTH")"
      qtone3="green"
      if ((bar_pct >= 95)); then
        qtone3="red"
      elif ((bar_pct >= 80)); then
        qtone3="orange"
      fi
      printf -v qtext3 "%3d%% [%s]" "$bar_pct" "$bar"
      note_parts=()
      note_parts+=("${daily_used}% of week today")
      note_parts+=("${allowance_per_day}%/day budget")
      daily_reset_hint="$(join_with_semicolon "${note_parts[@]}")"
      note3_disp="$daily_reset_hint"
      if [[ -n "$note3_disp" ]]; then
        printf -v note3_disp "%b" "${DIM}${note3_disp}${RESET}"
      fi
      daily_quota_segment="$(colorize "$qtext3" "$qtone3")"
      if [[ -n "$note3_disp" ]]; then
        daily_quota_segment+=" ${note3_disp}"
      fi
    fi
  fi
fi

if ((QUOTA_WEEK_PARTITION == 5 || QUOTA_WEEK_PARTITION == 7)) && [[ -z "$daily_quota_segment" ]]; then
  allowance_per_day=$(((100 + QUOTA_WEEK_PARTITION / 2) / QUOTA_WEEK_PARTITION))
  bar="$(build_quota_bar 0 "$QUOTA_BAR_WIDTH")"
  qtext3=$(printf "%3d%% [%s]" 0 "$bar")
  note3_disp=$(printf "%b" "${DIM}${allowance_per_day}%%/day budget${RESET}")
  daily_quota_segment="$(colorize "$qtext3" "green") ${note3_disp}"
  daily_allowance_used_pct=0
fi

quota_warn_threshold=$((quota_limit - 10))
if ((quota_warn_threshold < 0)); then
  quota_warn_threshold=0
fi
quota_reasons=()
quota_warnings=()
if [[ "$(lowercase "$CHATGPT_STATUS")" == "limit_reached" ]]; then
  quota_reasons+=("ChatGPT status limit_reached")
fi
if [[ "$CHATGPT_PRIMARY_USED" =~ ^[0-9]+$ ]]; then
  if ((CHATGPT_PRIMARY_USED >= quota_limit)); then
    reason="${lane_prefix}5h quota reached (${CHATGPT_PRIMARY_USED}% used"
    [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
    reason+=")"
    quota_reasons+=("$reason")
  elif ((CHATGPT_PRIMARY_USED >= quota_warn_threshold)); then
    reason="${lane_prefix}5h quota high (${CHATGPT_PRIMARY_USED}% used"
    [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
    reason+=")"
    quota_warnings+=("$reason")
  fi
fi
if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
  if ((CHATGPT_SECONDARY_USED >= quota_limit)); then
    reason="${lane_prefix}week quota reached (${CHATGPT_SECONDARY_USED}% used"
    [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
    reason+=")"
    quota_reasons+=("$reason")
  elif ((CHATGPT_SECONDARY_USED >= quota_warn_threshold)); then
    reason="${lane_prefix}week quota high (${CHATGPT_SECONDARY_USED}% used"
    [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
    reason+=")"
    quota_warnings+=("$reason")
  fi
fi
if [[ "$daily_allowance_used_pct" =~ ^[0-9]+$ ]]; then
  if ((daily_allowance_used_pct >= quota_limit)); then
    reason="daily budget hit (${daily_allowance_used_pct}%"
    [[ -n "$daily_reset_hint" ]] && reason+="; ${daily_reset_hint}"
    reason+=")"
    quota_reasons+=("$reason")
  elif ((daily_allowance_used_pct >= quota_warn_threshold)); then
    reason="daily budget high (${daily_allowance_used_pct}%"
    [[ -n "$daily_reset_hint" ]] && reason+="; ${daily_reset_hint}"
    reason+=")"
    quota_warnings+=("$reason")
  fi
fi
if ((${#quota_reasons[@]})); then
  QUOTA_BLOCKED=1
  QUOTA_BLOCK_REASON="$(human_join "${quota_reasons[@]}")"
fi
if ((${#quota_warnings[@]})); then
  QUOTA_WARNING=1
  QUOTA_WARNING_REASON="$(human_join "${quota_warnings[@]}")"
fi
