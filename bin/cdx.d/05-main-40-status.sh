codex_target_label="${codex_target_label:-${remote_tag:-${remote_version:-${LOCAL_VERSION:-unknown}}}}"
wrapper_target_label="${wrapper_target_label:-${WRAPPER_VERSION}}"
wrapper_installed_label="${WRAPPER_VERSION:-unknown}"
codex_installed_label="${codex_installed_label:-${LOCAL_VERSION:-unknown}}"

codex_status_display="$codex_status_label"
if [[ -n "$codex_status_note" ]]; then
  codex_status_display="${codex_status_display} (${codex_status_note})"
fi
wrapper_status_display="$wrapper_status_label"
if [[ -n "$wrapper_status_note" ]]; then
  wrapper_status_display="${wrapper_status_display} (${wrapper_status_note})"
fi

codex_installed_display="$codex_installed_label"
if [[ -n "$codex_installed_display" ]]; then
  codex_installed_display+=" installed"
fi
codex_target_display="$codex_target_label"
if [[ -n "$codex_target_display" && "$codex_target_display" != "n/a" && "$codex_target_display" != "unknown" ]]; then
  codex_target_display+=" available"
fi
wrapper_installed_display="$wrapper_installed_label"
if [[ -n "$wrapper_installed_display" ]]; then
  wrapper_installed_display+=" installed"
fi
wrapper_target_display="$wrapper_target_label"
if [[ -n "$wrapper_target_display" && "$wrapper_target_display" != "n/a" && "$wrapper_target_display" != "unknown" ]]; then
  wrapper_target_display+=" available"
fi

api_label="Unavailable"
api_tone="red"
case "$AUTH_PULL_STATUS" in
  ok)
    api_label="Up and working"
    api_tone="green"
    ;;
  offline)
    api_label="Unavailable (offline"
    if [[ -n "$AUTH_PULL_REASON" ]]; then
      api_label+="; ${AUTH_PULL_REASON}"
    fi
    api_label+=")"
    api_tone="yellow"
    ;;
  disabled)
    api_label="API disabled"
    api_tone="red"
    ;;
  invalid)
    api_label="Invalid API key"
    api_tone="red"
    ;;
  missing-config)
    api_label="Missing API config"
    api_tone="red"
    ;;
  insecure)
    api_label="Insecure host blocked"
    api_tone="red"
    ;;
  insecure-denied)
    api_label="Insecure approval denied"
    api_tone="red"
    ;;
  concurrent)
    api_label="Concurrent guard active"
    api_tone="yellow"
    ;;
esac

auth_label="n/a"
if [[ -n "$AUTH_STATUS" ]]; then
  auth_label="$(format_auth_label "$AUTH_STATUS" "$AUTH_ACTION" "$AUTH_MESSAGE")"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  cached_lr="${ORIGINAL_LAST_REFRESH:-unknown}"
  offline_hint=""
  [[ -n "$AUTH_PULL_REASON" ]] && offline_hint="; ${AUTH_PULL_REASON}"
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    auth_label="using cached auth (api offline${offline_hint}; last_refresh ${cached_lr})"
  elif (( HAS_LOCAL_AUTH )) && (( HOST_IS_SECURE )) && (( LOCAL_AUTH_IS_RECENT )); then
    auth_label="using cached auth (secure host; api offline${offline_hint}; last_refresh ${cached_lr})"
  elif (( HAS_LOCAL_AUTH )); then
    auth_label="cached auth stale (api offline${offline_hint}; last_refresh ${cached_lr})"
  else
    auth_label="auth unavailable (api offline${offline_hint})"
  fi
elif [[ "$AUTH_PULL_STATUS" == "insecure" ]]; then
  auth_label="insecure host window closed"
elif [[ "$AUTH_PULL_STATUS" == "insecure-denied" ]]; then
  auth_label="insecure host approval denied"
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    auth_label="concurrent guard active; using local auth.json"
  else
    auth_label="concurrent guard active; local auth.json missing or invalid"
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_label="auth sync failed"
fi

auth_tone="yellow"
case "$AUTH_STATUS" in
  valid|"")
    [[ "$AUTH_PULL_STATUS" == "ok" ]] && auth_tone="green"
    ;;
  outdated|missing|upload_required)
    if (( HOST_IS_SECURE )); then
      auth_tone="yellow"
    else
      auth_tone="green"
    fi
    ;;
  *)
    auth_tone="yellow"
    ;;
esac
if [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT) )); then
    auth_tone="yellow"
  else
    auth_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    auth_tone="yellow"
  else
    auth_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_tone="red"
fi

runner_label=""
runner_tone="yellow"
runner_enabled_flag=0
[[ "$RUNNER_ENABLED" == "1" ]] && runner_enabled_flag=1
if (( runner_enabled_flag )) || [[ -n "$RUNNER_STATE$RUNNER_LAST_OK$RUNNER_LAST_FAIL" ]]; then
  state="$(lowercase "$RUNNER_STATE")"
  last_ok_rel="$(format_relative_iso "$RUNNER_LAST_OK" 2>/dev/null || true)"
  last_fail_rel="$(format_relative_iso "$RUNNER_LAST_FAIL" 2>/dev/null || true)"
  if (( runner_enabled_flag )); then
    if [[ "$state" == "fail" ]]; then
      runner_tone="red"
      runner_label="runner failing"
      if [[ -n "$last_fail_rel" ]]; then
        runner_label+=" (${last_fail_rel})"
      fi
      if [[ -n "$last_ok_rel" ]]; then
        runner_label+="; last ok ${last_ok_rel}"
      fi
    else
      runner_tone="green"
      if [[ -n "$last_ok_rel" ]]; then
        age_seconds="$(seconds_since_iso "$RUNNER_LAST_OK" 2>/dev/null || true)"
        if [[ "$age_seconds" =~ ^-?[0-9]+$ ]]; then
          (( age_seconds < 0 )) && age_seconds=$(( -age_seconds ))
          if (( age_seconds <= 90 )); then
            runner_label="runner verified recently"
          else
            runner_label="runner verified ${last_ok_rel}"
          fi
          if (( age_seconds >= RUNNER_STALE_CRIT_SECONDS )); then
            runner_tone="red"
            runner_label+=" (stale)"
          elif (( age_seconds >= RUNNER_STALE_WARN_SECONDS )); then
            runner_tone="yellow"
            runner_label+=" (stale)"
          fi
        else
          runner_label="runner verified ${last_ok_rel}"
        fi
      else
        runner_tone="yellow"
        runner_label="runner enabled; no successful verification yet"
        if [[ -n "$last_fail_rel" ]]; then
          runner_label+=" (last fail ${last_fail_rel})"
        fi
      fi
    fi
  else
    runner_label="runner disabled"
  fi
fi

prompt_label="sync skipped"
prompt_tone="yellow"
if [[ "$PROMPT_SYNC_STATUS" == "ok" ]]; then
  prompt_label="synced"
  counts=()
  if [[ "$PROMPT_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("local ${PROMPT_LOCAL_COUNT}")
  fi
  if [[ "$PROMPT_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("remote ${PROMPT_REMOTE_COUNT}")
  fi
  if (( ${#counts[@]} )); then
    prompt_label+=" ($(join_with_semicolon "${counts[@]}"))"
  fi
  if [[ "$PROMPT_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( PROMPT_PULL_UPDATED > 0 )); then
    prompt_label+=" (${PROMPT_PULL_UPDATED} updated)"
  fi
  if [[ "$PROMPT_REMOVED" =~ ^[0-9]+$ ]] && (( PROMPT_REMOVED > 0 )); then
    prompt_label+=" (${PROMPT_REMOVED} removed)"
  fi
  if [[ "$PROMPT_PULL_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PULL_ERRORS > 0 )); then
    prompt_label+=" (${PROMPT_PULL_ERRORS} fetch errors)"
    prompt_tone="yellow"
  else
    prompt_tone="green"
  fi
elif [[ "$PROMPT_SYNC_STATUS" == "missing-config" ]]; then
  prompt_label="sync config missing"
  prompt_tone="red"
elif [[ "$PROMPT_SYNC_STATUS" == "no-python" ]]; then
  prompt_label="sync requires python3"
  prompt_tone="yellow"
elif [[ "$PROMPT_SYNC_STATUS" == "offline" ]]; then
  prompt_label="sync unavailable"
  if [[ -n "$PROMPT_SYNC_REASON" ]]; then
    prompt_label+=" (${PROMPT_SYNC_REASON})"
  fi
  prompt_tone="yellow"
elif [[ "$PROMPT_SYNC_STATUS" == "error" ]]; then
  prompt_label="sync failed"
  prompt_tone="red"
fi

skill_label="skills via MCP"
skill_tone="green"
if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && (( SKILL_REMOVED > 0 )); then
  skill_label+=" (${SKILL_REMOVED} local legacy paths removed)"
fi

agents_label="AGENTS sync skipped"
agents_tone="yellow"
if [[ "$AGENTS_SYNC_STATUS" == "ok" ]]; then
  case "$AGENTS_STATE" in
    updated)
      agents_label="AGENTS updated"
      agents_tone="green"
      ;;
    unchanged)
      agents_label="AGENTS current"
      agents_tone="green"
      ;;
    missing)
      agents_label="AGENTS cleared"
      agents_tone="yellow"
      ;;
    *)
      agents_label="AGENTS synced"
      agents_tone="green"
      ;;
  esac
elif [[ "$AGENTS_SYNC_STATUS" == "missing-config" ]]; then
  agents_label="AGENTS sync config missing"
  agents_tone="red"
elif [[ "$AGENTS_SYNC_STATUS" == "no-python" ]]; then
  agents_label="AGENTS sync requires python3"
  agents_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "offline" ]]; then
  agents_label="AGENTS sync unavailable"
  if [[ -n "$AGENTS_SYNC_REASON" ]]; then
    agents_label+=" (${AGENTS_SYNC_REASON})"
  fi
  agents_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  agents_label="AGENTS sync failed"
  agents_tone="red"
fi

config_label="config sync skipped"
config_tone="yellow"
if [[ "$CONFIG_SYNC_STATUS" == "ok" ]]; then
  case "$CONFIG_STATE" in
    updated)
      config_label="config updated"
      config_tone="green"
      ;;
    unchanged)
      config_label="config current"
      config_tone="green"
      ;;
    missing)
      config_label="config cleared"
      config_tone="yellow"
      ;;
    *)
      config_label="config synced"
      config_tone="green"
      ;;
  esac
elif [[ "$CONFIG_SYNC_STATUS" == "missing-config" ]]; then
  config_label="config sync config missing"
  config_tone="red"
elif [[ "$CONFIG_SYNC_STATUS" == "no-python" ]]; then
  config_label="config sync requires python3"
  config_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "offline" ]]; then
  config_label="config sync unavailable"
  if [[ -n "$CONFIG_SYNC_REASON" ]]; then
    config_label+=" (${CONFIG_SYNC_REASON})"
  fi
  config_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  config_label="config sync failed"
  config_tone="red"
fi

case "$PROMPT_PUSH_STATUS" in
  ok)
    if [[ "$PROMPT_PUSHED" =~ ^[0-9]+$ ]] && (( PROMPT_PUSHED > 0 )); then
      prompt_label+="; pushed ${PROMPT_PUSHED}"
    fi
    if [[ "$PROMPT_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PUSH_ERRORS > 0 )); then
      prompt_label+="; push errors ${PROMPT_PUSH_ERRORS}"
      prompt_tone="yellow"
    fi
    ;;
  no-baseline)
    prompt_label+="; push skipped (no baseline)"
    ;;
  no-python)
    prompt_label+="; push skipped (python missing)"
    ;;
  missing-config)
    prompt_label+="; push skipped (config missing)"
    prompt_tone="red"
    ;;
  error)
    prompt_label+="; push failed"
    prompt_tone="red"
    ;;
esac

command_actions=()
if (( codex_update_attempted )); then command_actions+=("codex"); fi
if (( wrapper_update_attempted )); then command_actions+=("wrapper"); fi
should_flag_auth=1
if (( ! HOST_IS_SECURE )) && [[ "$AUTH_PULL_STATUS" == "ok" ]] && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  should_flag_auth=0
fi
if (( should_flag_auth )) && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ || "$AUTH_ACTION" == "store" ]]; then command_actions+=("auth"); fi
command_label="launching codex"
if (( ${#command_actions[@]} )); then
  command_label="updating $(human_join "${command_actions[@]}")"
fi

result_parts=()
if (( codex_updated )); then
  result_parts+=("codex updated")
elif (( codex_update_failed )); then
  result_parts+=("codex update failed")
else
  result_parts+=("codex $(lowercase "$codex_status_label")")
fi
if (( wrapper_updated )); then
  result_parts+=("wrapper updated")
elif (( wrapper_update_failed )); then
  result_parts+=("wrapper update failed")
else
  result_parts+=("wrapper $(lowercase "$wrapper_status_label")")
fi
if [[ -n "$AUTH_STATUS" ]]; then
  if (( ! HOST_IS_SECURE )) && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
    auth_result="auth refreshed (insecure host)"
    if [[ -n "$AUTH_MESSAGE" ]]; then
      auth_result+=", ${AUTH_MESSAGE}"
    fi
  else
    auth_result="auth ${AUTH_STATUS}"
    if [[ -n "$AUTH_ACTION" ]]; then
      auth_result+=", ${AUTH_ACTION}"
    fi
  fi
  result_parts+=("$auth_result")
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  offline_note="api offline"
  [[ -n "$AUTH_PULL_REASON" ]] && offline_note+="; ${AUTH_PULL_REASON}"
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
    result_parts+=("auth cached (${offline_note})")
  elif (( HAS_LOCAL_AUTH )) && (( HOST_IS_SECURE )) && (( LOCAL_AUTH_IS_RECENT )); then
    result_parts+=("auth cached (secure host; ${offline_note})")
  elif (( HAS_LOCAL_AUTH )); then
    result_parts+=("auth stale (${offline_note})")
  else
    result_parts+=("auth unavailable (${offline_note})")
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    result_parts+=("auth local-only (active cdx run)")
  else
    result_parts+=("auth unavailable (active cdx run; local auth invalid)")
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  result_parts+=("auth unavailable")
fi
if [[ "$PROMPT_SYNC_STATUS" == "ok" ]]; then
  prompt_result="prompts synced"
  if [[ "$PROMPT_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    prompt_result+=" (local ${PROMPT_LOCAL_COUNT}"
    if [[ "$PROMPT_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
      prompt_result+=", remote ${PROMPT_REMOTE_COUNT}"
    fi
    prompt_result+=")"
  fi
  if [[ "$PROMPT_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( PROMPT_PULL_UPDATED > 0 )); then
    prompt_result+=" (${PROMPT_PULL_UPDATED} updated)"
  fi
  if [[ "$PROMPT_PUSHED" =~ ^[0-9]+$ ]] && (( PROMPT_PUSHED > 0 )); then
    prompt_result+="; pushed ${PROMPT_PUSHED}"
  fi
  if [[ "$PROMPT_REMOVED" =~ ^[0-9]+$ ]] && (( PROMPT_REMOVED > 0 )); then
    prompt_result+="; removed ${PROMPT_REMOVED}"
  fi
  if [[ "$PROMPT_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PUSH_ERRORS > 0 )); then
    prompt_result+="; push errors ${PROMPT_PUSH_ERRORS}"
  fi
  result_parts+=("$prompt_result")
elif [[ "$PROMPT_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("prompts config missing")
elif [[ "$PROMPT_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("prompts python missing")
elif [[ "$PROMPT_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$PROMPT_SYNC_REASON" ]]; then
    result_parts+=("prompts offline (${PROMPT_SYNC_REASON})")
  else
    result_parts+=("prompts offline")
  fi
elif [[ "$PROMPT_SYNC_STATUS" == "error" ]]; then
  result_parts+=("prompts sync failed")
fi
if [[ "$PROMPT_PUSH_STATUS" == "error" ]]; then
  result_parts+=("prompts push failed")
fi
skill_result="skills via MCP"
if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && (( SKILL_REMOVED > 0 )); then
  skill_result+="; cleanup removed ${SKILL_REMOVED}"
fi
result_parts+=("$skill_result")
if [[ "$AGENTS_SYNC_STATUS" == "ok" ]]; then
  case "$AGENTS_STATE" in
    updated)
      result_parts+=("AGENTS.md updated")
      ;;
    unchanged)
      result_parts+=("AGENTS.md current")
      ;;
    missing)
      result_parts+=("AGENTS.md cleared")
      ;;
    *)
      result_parts+=("AGENTS.md synced")
      ;;
  esac
elif [[ "$AGENTS_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("AGENTS.md config missing")
elif [[ "$AGENTS_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("AGENTS.md python missing")
elif [[ "$AGENTS_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$AGENTS_SYNC_REASON" ]]; then
    result_parts+=("AGENTS.md offline (${AGENTS_SYNC_REASON})")
  else
    result_parts+=("AGENTS.md offline")
  fi
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  result_parts+=("AGENTS.md sync failed")
fi
if [[ "$CONFIG_SYNC_STATUS" == "ok" ]]; then
  case "$CONFIG_STATE" in
    updated)
      result_parts+=("config.toml updated")
      ;;
    unchanged)
      result_parts+=("config.toml current")
      ;;
    missing)
      result_parts+=("config.toml cleared")
      ;;
    *)
      result_parts+=("config.toml synced")
      ;;
  esac
elif [[ "$CONFIG_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("config.toml config missing")
elif [[ "$CONFIG_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("config.toml python missing")
elif [[ "$CONFIG_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$CONFIG_SYNC_REASON" ]]; then
    result_parts+=("config.toml offline (${CONFIG_SYNC_REASON})")
  else
    result_parts+=("config.toml offline")
  fi
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  result_parts+=("config.toml sync failed")
fi
if (( QUOTA_BLOCKED )); then
  result_parts+=("${QUOTA_BLOCK_REASON:-quota reached}")
fi
result_label="$(human_join "${result_parts[@]}")"

  usage_summary=""
  if [[ -n "$last_usage_payload" ]]; then
    usage_summary="$(parse_usage_summary "$last_usage_payload")"
  fi

  codex_tone="green"
  case "$(lowercase "$codex_status_label")" in
    update\ available|check\ skipped|update\ skipped|deferred)
      codex_tone="yellow"
      ;;
    blocked\ on\ ssh)
      codex_tone="red"
      ;;
  update\ failed|api\ unavailable)
    codex_tone="red"
    ;;
esac
(( codex_update_failed )) && codex_tone="red"

wrapper_tone="green"
case "$(lowercase "$wrapper_status_label")" in
  update\ available|update\ skipped|check\ skipped)
    wrapper_tone="yellow"
    ;;
  update\ failed)
    wrapper_tone="red"
    ;;
esac
(( wrapper_update_failed )) && wrapper_tone="red"

result_tone="green"
if (( codex_update_failed )) || (( wrapper_update_failed )) || { [[ "$AUTH_PULL_STATUS" != "ok" ]] && [[ "$AUTH_PULL_STATUS" != "offline" ]] && [[ "$AUTH_PULL_STATUS" != "concurrent" ]]; }; then
  result_tone="red"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT) )); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if (( HAS_VALID_LOCAL_AUTH )); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$(lowercase "$codex_status_label")" == "blocked on ssh" ]]; then
  result_tone="red"
elif [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  result_tone="yellow"
elif [[ "$(lowercase "$codex_status_label")" == "update available" ]] || [[ "$(lowercase "$wrapper_status_label")" == "update available" ]]; then
  result_tone="yellow"
elif [[ "$PROMPT_SYNC_STATUS" == "error" || "$PROMPT_PUSH_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$PROMPT_SYNC_STATUS" != "ok" && "$PROMPT_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif [[ "$PROMPT_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( PROMPT_PUSH_ERRORS > 0 )); then
  result_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$AGENTS_SYNC_STATUS" != "ok" && "$AGENTS_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$CONFIG_SYNC_STATUS" != "ok" && "$CONFIG_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif (( QUOTA_WARNING )); then
  result_tone="yellow"
elif (( QUOTA_BLOCKED )); then
  result_tone="red"
fi

insecure_compact_ok=0
if (( ! HOST_IS_SECURE )); then
  if (( ! codex_updated )) && (( ! codex_update_failed )) \
    && (( ! wrapper_updated )) && (( ! wrapper_update_failed )) \
    && [[ "$AUTH_PULL_STATUS" == "ok" ]] \
    && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]] \
    && [[ "$PROMPT_SYNC_STATUS" == "ok" ]] \
    && [[ "${PROMPT_PULL_UPDATED:-0}" == "0" ]] \
    && [[ "${PROMPT_PUSHED:-0}" == "0" ]] \
    && [[ "${PROMPT_REMOVED:-0}" == "0" ]] \
    && [[ "${PROMPT_PUSH_ERRORS:-0}" == "0" ]] \
    && [[ "$SKILL_SYNC_STATUS" == "mcp" ]] \
    && [[ "$AGENTS_SYNC_STATUS" == "ok" ]] \
    && [[ "$AGENTS_STATE" == "unchanged" ]] \
    && [[ "$CONFIG_SYNC_STATUS" == "ok" ]] \
    && [[ "$CONFIG_STATE" == "unchanged" ]]; then
    insecure_compact_ok=1
  fi
fi

command_tone=""
if (( ${#command_actions[@]} )); then
  command_tone="yellow"
fi
if (( QUOTA_WARNING )); then
  command_tone="yellow"
fi
if (( QUOTA_BLOCKED )); then
  command_tone="red"
fi
