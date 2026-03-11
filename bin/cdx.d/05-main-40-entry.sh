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

skill_label="skills sync skipped"
skill_tone="yellow"
if [[ "$SKILL_SYNC_STATUS" == "ok" ]]; then
  skill_label="skills synced"
  counts=()
  if [[ "$SKILL_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("local ${SKILL_LOCAL_COUNT}")
  fi
  if [[ "$SKILL_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
    counts+=("remote ${SKILL_REMOTE_COUNT}")
  fi
  if (( ${#counts[@]} )); then
    skill_label+=" ($(join_with_semicolon "${counts[@]}"))"
  fi
  if [[ "$SKILL_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( SKILL_PULL_UPDATED > 0 )); then
    skill_label+=" (${SKILL_PULL_UPDATED} updated)"
  fi
  if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && (( SKILL_REMOVED > 0 )); then
    skill_label+=" (${SKILL_REMOVED} removed)"
  fi
  if [[ "$SKILL_PULL_ERRORS" =~ ^[0-9]+$ ]] && (( SKILL_PULL_ERRORS > 0 )); then
    skill_label+=" (${SKILL_PULL_ERRORS} fetch errors)"
    skill_tone="yellow"
  else
    skill_tone="green"
  fi
elif [[ "$SKILL_SYNC_STATUS" == "missing-config" ]]; then
  skill_label="sync config missing"
  skill_tone="red"
elif [[ "$SKILL_SYNC_STATUS" == "no-python" ]]; then
  skill_label="sync requires python3"
  skill_tone="yellow"
elif [[ "$SKILL_SYNC_STATUS" == "offline" ]]; then
  skill_label="sync unavailable"
  if [[ -n "$SKILL_SYNC_REASON" ]]; then
    skill_label+=" (${SKILL_SYNC_REASON})"
  fi
  skill_tone="yellow"
elif [[ "$SKILL_SYNC_STATUS" == "error" ]]; then
  skill_label="sync failed"
  skill_tone="red"
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

case "$SKILL_PUSH_STATUS" in
  ok)
    if [[ "$SKILL_PUSHED" =~ ^[0-9]+$ ]] && (( SKILL_PUSHED > 0 )); then
      skill_label+="; pushed ${SKILL_PUSHED}"
    fi
    if [[ "$SKILL_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( SKILL_PUSH_ERRORS > 0 )); then
      skill_label+="; push errors ${SKILL_PUSH_ERRORS}"
      skill_tone="yellow"
    fi
    ;;
  no-baseline)
    skill_label+="; push skipped (no baseline)"
    ;;
  no-python)
    skill_label+="; push skipped (python missing)"
    ;;
  missing-config)
    skill_label+="; push skipped (config missing)"
    skill_tone="red"
    ;;
  error)
    skill_label+="; push failed"
    skill_tone="red"
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
if [[ "$SKILL_SYNC_STATUS" == "ok" ]]; then
  skill_result="skills synced"
  if [[ "$SKILL_LOCAL_COUNT" =~ ^[0-9]+$ ]]; then
    skill_result+=" (local ${SKILL_LOCAL_COUNT}"
    if [[ "$SKILL_REMOTE_COUNT" =~ ^[0-9]+$ ]]; then
      skill_result+=", remote ${SKILL_REMOTE_COUNT}"
    fi
    skill_result+=")"
  fi
  if [[ "$SKILL_PULL_UPDATED" =~ ^[0-9]+$ ]] && (( SKILL_PULL_UPDATED > 0 )); then
    skill_result+=" (${SKILL_PULL_UPDATED} updated)"
  fi
  if [[ "$SKILL_PUSHED" =~ ^[0-9]+$ ]] && (( SKILL_PUSHED > 0 )); then
    skill_result+="; pushed ${SKILL_PUSHED}"
  fi
  if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && (( SKILL_REMOVED > 0 )); then
    skill_result+="; removed ${SKILL_REMOVED}"
  fi
  if [[ "$SKILL_PUSH_ERRORS" =~ ^[0-9]+$ ]] && (( SKILL_PUSH_ERRORS > 0 )); then
    skill_result+="; push errors ${SKILL_PUSH_ERRORS}"
  fi
  result_parts+=("$skill_result")
elif [[ "$SKILL_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("skills config missing")
elif [[ "$SKILL_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("skills python missing")
elif [[ "$SKILL_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$SKILL_SYNC_REASON" ]]; then
    result_parts+=("skills offline (${SKILL_SYNC_REASON})")
  else
    result_parts+=("skills offline")
  fi
elif [[ "$SKILL_SYNC_STATUS" == "error" ]]; then
  result_parts+=("skills sync failed")
fi
if [[ "$SKILL_PUSH_STATUS" == "error" ]]; then
  result_parts+=("skills push failed")
fi
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
    && [[ "$SKILL_SYNC_STATUS" == "ok" ]] \
    && [[ "${SKILL_PULL_UPDATED:-0}" == "0" ]] \
    && [[ "${SKILL_PUSHED:-0}" == "0" ]] \
    && [[ "${SKILL_REMOVED:-0}" == "0" ]] \
    && [[ "${SKILL_PUSH_ERRORS:-0}" == "0" ]] \
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

  if (( ! HOST_IS_SECURE )); then
    if (( insecure_compact_ok )); then
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
  if (( quota_limit < 50 )); then
    quota_limit=50
  elif (( quota_limit > 100 )); then
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
      quota_lane_display="${quota_lane_display} ⚡"
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
  if (( partition_days != 5 && partition_days != 7 )); then
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

  prompt_state="in sync"
  if [[ "$prompt_tone" == "green" ]]; then
    if [[ "$prompt_label" =~ local[[:space:]]+([0-9]+).*remote[[:space:]]+([0-9]+) ]]; then
      prompt_state="in sync (${BASH_REMATCH[1]}/${BASH_REMATCH[2]})"
    fi
  else
    prompt_state="${prompt_label:-needs attention}"
    prompt_state="$(colorize "$prompt_state" "$prompt_tone")"
  fi
  health_rows+=("${bullet} Prompts: ${prompt_state}")

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

  if (( QUOTA_HARD_FAIL )); then
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
  if (( ${#usage_rows[@]} == 0 )); then
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
        if (( other_projection_pct >= 100 )); then
          other_projection_note="proj 100% at reset"
          other_projection_alert=1
        else
          other_projection_note="proj ~${other_projection_pct}% at reset"
        fi
      fi
      other_qnote_full="$(join_with_semicolon "$other_qnote2" "$other_projection_note")"
      other_qnote2_disp="$other_qnote_full"
      if [[ -n "$other_qnote2_disp" ]]; then
        if (( other_projection_alert )); then
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
      if (( projection_pct >= 100 )); then
        projection_note="proj 100% at reset"
        projection_alert=1
      else
        projection_note="proj ~${projection_pct}% at reset"
      fi
    fi
    qnote_full="$(join_with_semicolon "$qnote2" "$projection_note")"
    secondary_reset_hint="$qnote_full"
    qnote2_disp="$qnote_full"
    if [[ -n "$qnote2_disp" ]]; then
      if (( projection_alert )); then
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
  if (( QUOTA_WEEK_PARTITION == 5 || QUOTA_WEEK_PARTITION == 7 )); then
    if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
      partition_days="$QUOTA_WEEK_PARTITION"
      allowance_per_day=$(( (100 + partition_days / 2) / partition_days ))
      (( allowance_per_day < 1 )) && allowance_per_day=1
      daily_used="${CHATGPT_DAILY_USED:-}"
      if [[ "$daily_used" =~ ^[0-9]+$ ]]; then
        bar_pct=$(( (daily_used * 100 + allowance_per_day / 2) / allowance_per_day ))
        (( bar_pct < 0 )) && bar_pct=0
        (( bar_pct > 999 )) && bar_pct=999
        daily_allowance_used_pct=$bar_pct
        bar_display=$bar_pct
        (( bar_display > 100 )) && bar_display=100
        bar="$(build_quota_bar "$bar_display" "$QUOTA_BAR_WIDTH")"
        qtone3="green"
        if (( bar_pct >= 95 )); then
          qtone3="red"
        elif (( bar_pct >= 80 )); then
          qtone3="orange"
        fi
        printf -v qtext3 "%3d%% [%s]" "$bar_pct" "$bar"
        note_parts=()
        note_parts+=("today used ${daily_used}% of week")
        note_parts+=("allowance ${allowance_per_day}%/day")
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

  if (( QUOTA_WEEK_PARTITION == 5 || QUOTA_WEEK_PARTITION == 7 )) && [[ -z "$daily_quota_segment" ]]; then
    allowance_per_day=$(( (100 + QUOTA_WEEK_PARTITION / 2) / QUOTA_WEEK_PARTITION ))
    bar="$(build_quota_bar 0 "$QUOTA_BAR_WIDTH")"
    qtext3=$(printf "%3d%% [%s]" 0 "$bar")
    note3_disp=$(printf "%b" "${DIM}allowance ${allowance_per_day}%/day${RESET}")
    daily_quota_segment="$(colorize "$qtext3" "green") ${note3_disp}"
    daily_allowance_used_pct=0
  fi

  quota_warn_threshold=$(( quota_limit - 10 ))
  if (( quota_warn_threshold < 0 )); then
    quota_warn_threshold=0
  fi
  quota_reasons=()
  quota_warnings=()
  if [[ "$(lowercase "$CHATGPT_STATUS")" == "limit_reached" ]]; then
    quota_reasons+=("ChatGPT status limit_reached")
  fi
  if [[ "$CHATGPT_PRIMARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_PRIMARY_USED >= quota_limit )); then
      reason="${lane_prefix}5h quota reached (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_PRIMARY_USED >= quota_warn_threshold )); then
      reason="${lane_prefix}5h quota high (${CHATGPT_PRIMARY_USED}% used"
      [[ -n "$primary_reset_hint" ]] && reason+="; ${primary_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if [[ "$CHATGPT_SECONDARY_USED" =~ ^[0-9]+$ ]]; then
    if (( CHATGPT_SECONDARY_USED >= quota_limit )); then
      reason="${lane_prefix}week quota reached (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( CHATGPT_SECONDARY_USED >= quota_warn_threshold )); then
      reason="${lane_prefix}week quota high (${CHATGPT_SECONDARY_USED}% used"
      [[ -n "$secondary_reset_hint" ]] && reason+="; ${secondary_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if [[ "$daily_allowance_used_pct" =~ ^[0-9]+$ ]]; then
    if (( daily_allowance_used_pct >= quota_limit )); then
      reason="daily allowance reached (${daily_allowance_used_pct}% of allowance"
      [[ -n "$daily_reset_hint" ]] && reason+="; ${daily_reset_hint}"
      reason+=")"
      quota_reasons+=("$reason")
    elif (( daily_allowance_used_pct >= quota_warn_threshold )); then
      reason="daily allowance high (${daily_allowance_used_pct}% of allowance"
      [[ -n "$daily_reset_hint" ]] && reason+="; ${daily_reset_hint}"
      reason+=")"
      quota_warnings+=("$reason")
    fi
  fi
  if (( ${#quota_reasons[@]} )); then
    QUOTA_BLOCKED=1
    QUOTA_BLOCK_REASON="$(human_join "${quota_reasons[@]}")"
  fi
  if (( ${#quota_warnings[@]} )); then
    QUOTA_WARNING=1
    QUOTA_WARNING_REASON="$(human_join "${quota_warnings[@]}")"
  fi

  concurrent_compact_summary=0
  concurrent_compact_note=""
  concurrent_compact_tone="yellow"
  if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    concurrent_compact_summary=1
    if (( HAS_VALID_LOCAL_AUTH )); then
      concurrent_compact_note="Concurrent guard active; using local auth.json."
    elif (( HAS_LOCAL_AUTH )); then
      concurrent_compact_note="Concurrent guard active; local auth.json is invalid."
      concurrent_compact_tone="red"
    else
      concurrent_compact_note="Concurrent guard active; local auth.json is missing."
      concurrent_compact_tone="red"
    fi
  fi

  if (( ! wrapper_updated || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
    row_label_width_default="$ROW_LABEL_WIDTH"
    summary_row_labels=("Health" "Versions" "Usage" "Quota" "Result" "Concurrent" "Other lane")
    ROW_LABEL_WIDTH="$(compute_row_label_width "${summary_row_labels[@]}")"

    if (( CODEX_MINIMAL_OUTPUT )); then
      minimal_health_line="api=${api_tone} auth=${auth_tone} prompts=${prompt_tone} skills=${skill_tone} codex=${codex_tone} wrapper=${wrapper_tone}"
      if [[ -n "$agents_label" ]]; then
        minimal_health_line+=" agents=${agents_tone}"
      fi
      if [[ -n "$config_label" ]]; then
        minimal_health_line+=" config=${config_tone}"
      fi
      if (( QUOTA_BLOCKED )); then
        minimal_health_line+=" quota=blocked"
      elif (( QUOTA_WARNING )); then
        minimal_health_line+=" quota=warn"
      fi
      minimal_result_line="$result_label"
      if [[ "${HOST_VIP:-0}" == "1" ]]; then
        minimal_result_line+=" (vip)"
      fi
      log_info "$(format_simple_row "Health" "$minimal_health_line")"
      log_info "$(format_simple_row "Result" "$minimal_result_line")"
    else
      if (( concurrent_compact_summary )); then
        print_section_rows "Concurrent" "${bullet} $(colorize "$concurrent_compact_note" "$concurrent_compact_tone")"
      else
        print_section_rows "Health" "${health_rows[@]}"
        print_section_rows "Versions" "${version_rows[@]}"
        print_section_rows "Usage" "${usage_rows[@]}"
      fi

      quota_rows=()
      quota_metric_labels=("Active lane")
      if [[ -n "$primary_quota_segment" ]]; then
        quota_metric_labels+=("5h window")
      fi
      if [[ -n "$secondary_quota_segment" ]]; then
        quota_metric_labels+=("Weekly window")
      fi
      if [[ -n "$daily_quota_segment" ]] && (( QUOTA_WARNING || QUOTA_BLOCKED || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
        quota_metric_labels+=("Daily allowance")
      fi
      if [[ -n "$other_lane_primary_quota_segment" ]]; then
        quota_metric_labels+=("${other_lane_label} 5h window")
      fi
      if [[ -n "$other_lane_secondary_quota_segment" ]]; then
        quota_metric_labels+=("${other_lane_label} weekly window")
      fi
      quota_metric_label_width=0
      for quota_metric_label in "${quota_metric_labels[@]}"; do
        quota_metric_len=${#quota_metric_label}
        if (( quota_metric_len > quota_metric_label_width )); then
          quota_metric_label_width=$quota_metric_len
        fi
      done
      (( quota_metric_label_width < 12 )) && quota_metric_label_width=12
      QUOTA_METRIC_LABEL_WIDTH="$quota_metric_label_width"

      quota_rows+=("${bullet} $(format_quota_metric_row "Active lane" "${quota_lane_display}")")
      if [[ -n "$primary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "5h window" "${primary_quota_segment}")")
      fi
      if [[ -n "$secondary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "Weekly window" "${secondary_quota_segment}")")
      fi
      if [[ -n "$daily_quota_segment" ]] && (( QUOTA_WARNING || QUOTA_BLOCKED || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
        quota_rows+=("${bullet} $(format_quota_metric_row "Daily allowance" "${daily_quota_segment}")")
      fi
      if [[ -n "$other_lane_primary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "${other_lane_label} 5h window" "${other_lane_primary_quota_segment}")")
      fi
      if [[ -n "$other_lane_secondary_quota_segment" ]]; then
        quota_rows+=("${bullet} $(format_quota_metric_row "${other_lane_label} weekly window" "${other_lane_secondary_quota_segment}")")
      fi
      if (( QUOTA_WARNING )) && [[ -n "$QUOTA_WARNING_REASON" ]]; then
        quota_rows+=("${bullet} $(colorize "Near limit: ${QUOTA_WARNING_REASON}" "yellow")")
      fi
      if (( QUOTA_BLOCKED )) && [[ -n "$QUOTA_BLOCK_REASON" ]]; then
        quota_rows+=("${bullet} $(colorize "Limit reached: ${QUOTA_BLOCK_REASON}" "red")")
      fi
      print_section_rows "Quota" "${quota_rows[@]}"

      if (( ! concurrent_compact_summary )); then
        print_section_rows "Result" "${bullet} ${result_line}"
      fi
    fi

    ROW_LABEL_WIDTH="$row_label_width_default"
  fi

if (( CODEX_DOCTOR_ONLY )); then
  print_doctor_report
  if (( DOCTOR_FAILURES > 0 )) || [[ "$result_tone" == "red" ]]; then
    release_run_lock_if_held || true
    exit 1
  fi
  release_run_lock_if_held || true
  exit 0
fi

if (( CODEX_STATUS_ONLY )); then
  if [[ "$result_tone" == "red" ]]; then
    release_run_lock_if_held || true
    exit 1
  fi
  release_run_lock_if_held || true
  exit 0
fi

if (( wrapper_updated )) && (( ! CODEX_EXIT_AFTER_UPDATE )) && (( ! CODEX_STATUS_ONLY )) && (( ! CODEX_DOCTOR_ONLY )); then
  if [[ "${CODEX_WRAPPER_RESTARTED:-0}" == "1" ]]; then
    release_run_lock_if_held || true
    log_error "Wrapper update loop detected; aborting."
    exit 1
  fi
  log_warn "Wrapper updated; restarting cdx to load the new wrapper."
  if ! declare -p CODEX_ORIGINAL_ARGC >/dev/null 2>&1 || [[ ! "${CODEX_ORIGINAL_ARGC:-}" =~ ^[0-9]+$ ]]; then
    CODEX_ORIGINAL_ARGC=0
  fi
  if ! declare -p CODEX_ORIGINAL_ARGS >/dev/null 2>&1; then
    CODEX_ORIGINAL_ARGS=()
  fi
  release_run_lock_if_held || true
  if (( CODEX_ORIGINAL_ARGC > 0 )); then
    CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "$SCRIPT_REAL" "${CODEX_ORIGINAL_ARGS[@]}"
  fi
  CODEX_SKIP_MOTD=1 CODEX_WRAPPER_RESTARTED=1 exec "$SCRIPT_REAL"
fi

AUTH_LAUNCH_ALLOWED=0
AUTH_LAUNCH_REASON=""
case "$AUTH_PULL_STATUS" in
  ok)
    AUTH_LAUNCH_ALLOWED=1
    ;;
  offline)
    offline_launch_hint=""
    [[ -n "$AUTH_PULL_REASON" ]] && offline_launch_hint=" (${AUTH_PULL_REASON})"
    if (( HAS_LOCAL_AUTH )) && (( LOCAL_AUTH_IS_FRESH )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; using cached auth.json"
    elif (( HAS_LOCAL_AUTH )) && (( HOST_IS_SECURE )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; secure host using cached auth.json"
    elif (( HAS_LOCAL_AUTH )); then
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; cached auth.json older than allowed window"
    else
      AUTH_LAUNCH_REASON="API offline${offline_launch_hint} and no cached auth.json"
    fi
    ;;
  invalid)
    AUTH_LAUNCH_REASON="Invalid API key; download a fresh wrapper or rotate the key."
    ;;
  missing-config)
    AUTH_LAUNCH_REASON="Auth configuration missing (base URL or API key)."
    ;;
  disabled)
    AUTH_LAUNCH_REASON="Auth API disabled by administrator."
    ;;
  insecure)
    AUTH_LAUNCH_REASON="Insecure host API disabled; enable the host window in the admin dashboard."
    ;;
  insecure-denied)
    AUTH_LAUNCH_REASON="Insecure host approval denied; re-run or open the host window."
    ;;
  concurrent)
    if (( HAS_VALID_LOCAL_AUTH )); then
      AUTH_LAUNCH_ALLOWED=1
      AUTH_LAUNCH_REASON="Active cdx run detected; using local auth.json with sync/update mutations skipped"
    elif (( HAS_LOCAL_AUTH )); then
      AUTH_LAUNCH_REASON="Active cdx run detected and local auth.json is invalid."
    else
      AUTH_LAUNCH_REASON="Active cdx run detected and no local auth.json is available."
    fi
    ;;
  fail)
    AUTH_LAUNCH_REASON="Auth sync failed; check API connectivity."
    ;;
  *)
    AUTH_LAUNCH_REASON="Auth unavailable; fix sync before retrying."
    ;;
esac

if (( AUTH_LAUNCH_ALLOWED == 1 )) && (( CODEX_LANE_WANTS_RUN )) && (( QUOTA_BLOCKED )); then
  if (( QUOTA_HARD_FAIL )); then
    AUTH_LAUNCH_ALLOWED=0
    AUTH_LAUNCH_REASON="${QUOTA_BLOCK_REASON:-ChatGPT quota reached}"
  else
    log_warn "ChatGPT quota reached: ${QUOTA_BLOCK_REASON:-see details above}. Continuing (warn mode)."
  fi
fi

if (( QUOTA_WARNING )) && (( AUTH_LAUNCH_ALLOWED == 1 )) && (( CODEX_LANE_WANTS_RUN )); then
  log_warn "ChatGPT quota near limit: ${QUOTA_WARNING_REASON:-see usage above}."
fi

if (( AUTH_LAUNCH_ALLOWED == 0 )); then
  release_run_lock_if_held || true
  log_error "${AUTH_LAUNCH_REASON:-Auth unavailable; refusing to start Codex. Re-run after fixing API key or provisioning auth.}"
  exit 1
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  log_warn "${AUTH_LAUNCH_REASON} (last_refresh ${ORIGINAL_LAST_REFRESH:-unknown})."
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  log_warn "${AUTH_LAUNCH_REASON}."
fi

if (( CODEX_LANE_PERSIST_REQUEST )); then
  if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    release_run_lock_if_held || true
    log_error "Cannot persist lane while another cdx run is active. Re-run with --allow-concurrent-sync if you want to override."
    exit 1
  fi
  lane_to_persist="$CODEX_LANE_TARGET"
  if [[ "$CODEX_LANE_CLEAR_REQUEST" == "1" ]]; then
    lane_to_persist=""
  fi
  if persist_lane_preference_with_api "$lane_to_persist"; then
    if [[ -n "$lane_to_persist" ]]; then
      log_info "Persisted host lane preference: ${lane_to_persist}"
    else
      log_info "Cleared host lane preference (host now follows inherited defaults)."
    fi
  else
    release_run_lock_if_held || true
    log_error "Failed to persist lane preference via /host/lane."
    exit 1
  fi
fi

if (( CODEX_LANE_COMMAND )); then
  lane_effective_display="${CODEX_EFFECTIVE_LANE:-normal}"
  lane_persisted_display="${HOST_LANE_PREFERENCE:-inherit}"
  lane_source_display="${CODEX_EFFECTIVE_LANE_SOURCE:-unknown}"
  if [[ "$lane_persisted_display" != "inherit" ]]; then
    lane_persisted_display="host:${lane_persisted_display}"
  fi
  log_info "Lane state | effective=${lane_effective_display} (${lane_source_display}) | persisted=${lane_persisted_display}"
  if (( CODEX_LANE_USER_SET )); then
    lane_request_line="Lane request | one-shot=${CODEX_LANE_TARGET}"
    if (( CODEX_LANE_PERSIST_REQUEST )); then
      lane_request_line+=", persisted"
    fi
    log_info "$lane_request_line"
  fi
fi

if (( CODEX_LANE_WANTS_RUN == 0 )); then
  release_run_lock_if_held || true
  exit 0
fi
