# ── CLX Status Computation ────────────────────────────────────
# Computes version labels, API status, auth status, runner status,
# sync statuses, quota, and builds the result summary.
# Ported from CDX 05-main-40-status.sh with Claude-specific naming.
#
# Helper functions (human_join, colorize, format_auth_label, seconds_since_iso,
# format_duration_short, format_relative_iso, join_with_semicolon, lowercase)
# and core status variables (AUTH_PULL_STATUS, HOST_IS_SECURE, QUOTA_*, etc.)
# are defined in 00-prolog.sh.

# ── Status variable defaults for fields not yet initialized ───
# Earlier fragments may set these; provide safe defaults for any gaps.
AUTH_STATUS="${AUTH_STATUS:-}"
AUTH_ACTION="${AUTH_ACTION:-}"
AUTH_MESSAGE="${AUTH_MESSAGE:-}"
LOCAL_AUTH_IS_RECENT="${LOCAL_AUTH_IS_RECENT:-0}"
QUOTA_LIMIT_PERCENT="${QUOTA_LIMIT_PERCENT:-100}"

RUNNER_ENABLED="${RUNNER_ENABLED:-0}"
RUNNER_STATE="${RUNNER_STATE:-}"
RUNNER_LAST_OK="${RUNNER_LAST_OK:-}"
RUNNER_LAST_FAIL="${RUNNER_LAST_FAIL:-}"
RUNNER_STALE_WARN_SECONDS="${RUNNER_STALE_WARN_SECONDS:-$((36 * 3600))}"
RUNNER_STALE_CRIT_SECONDS="${RUNNER_STALE_CRIT_SECONDS:-$((72 * 3600))}"

SKILL_SYNC_STATUS="${SKILL_SYNC_STATUS:-mcp}"
SKILL_REMOVED="${SKILL_REMOVED:-0}"

AGENTS_SYNC_STATUS="${AGENTS_SYNC_STATUS:-skip}"
AGENTS_SYNC_REASON="${AGENTS_SYNC_REASON:-}"
AGENTS_STATE="${AGENTS_STATE:-}"

CONFIG_SYNC_STATUS="${CONFIG_SYNC_STATUS:-skip}"
CONFIG_SYNC_REASON="${CONFIG_SYNC_REASON:-}"
CONFIG_STATE="${CONFIG_STATE:-}"

# Claude CLI version variables (from bootstrap or update fragment).
claude_status_label="${claude_status_label:-Current}"
claude_status_note="${claude_status_note:-}"
wrapper_status_label="${wrapper_status_label:-Current}"
wrapper_status_note="${wrapper_status_note:-}"
claude_updated="${claude_updated:-0}"
claude_update_failed="${claude_update_failed:-0}"
claude_update_attempted="${claude_update_attempted:-0}"
wrapper_update_failed="${wrapper_update_failed:-0}"
wrapper_update_attempted="${wrapper_update_attempted:-0}"
LOCAL_VERSION="${LOCAL_VERSION:-}"
remote_tag="${remote_tag:-}"
remote_version="${remote_version:-}"
skip_update_reason="${skip_update_reason:-}"

# Claude spend-based quota variables (from quota fragment).
CLAUDE_SPEND_USED="${CLAUDE_SPEND_USED:-}"
CLAUDE_SPEND_LIMIT="${CLAUDE_SPEND_LIMIT:-}"

# ── Version labels ────────────────────────────────────────────

claude_target_label="${claude_target_label:-${remote_tag:-${remote_version:-${LOCAL_VERSION:-unknown}}}}"
wrapper_target_label="${wrapper_target_label:-${WRAPPER_VERSION}}"
wrapper_installed_label="${WRAPPER_VERSION:-unknown}"
claude_installed_label="${claude_installed_label:-${LOCAL_VERSION:-unknown}}"

claude_status_display="$claude_status_label"
if [[ -n "$claude_status_note" ]]; then
  claude_status_display="${claude_status_display} (${claude_status_note})"
fi
wrapper_status_display="$wrapper_status_label"
if [[ -n "$wrapper_status_note" ]]; then
  wrapper_status_display="${wrapper_status_display} (${wrapper_status_note})"
fi

claude_version_suffix=""
case "${skip_update_reason:-}" in
  cron_managed) claude_version_suffix="(auto)" ;;
  privilege) claude_version_suffix="(manual)" ;;
esac

claude_installed_display="$claude_installed_label"
if [[ -n "$claude_installed_display" ]]; then
  claude_installed_display+=" installed"
fi
claude_target_display="$claude_target_label"
if [[ -n "$claude_target_display" && "$claude_target_display" != "n/a" && "$claude_target_display" != "unknown" ]]; then
  claude_target_display+=" available"
fi
wrapper_installed_display="$wrapper_installed_label"
if [[ -n "$wrapper_installed_display" ]]; then
  wrapper_installed_display+=" installed"
fi
wrapper_target_display="$wrapper_target_label"
if [[ -n "$wrapper_target_display" && "$wrapper_target_display" != "n/a" && "$wrapper_target_display" != "unknown" ]]; then
  wrapper_target_display+=" available"
fi

# ── API status ────────────────────────────────────────────────

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

# ── Auth status ───────────────────────────────────────────────

auth_label="n/a"
if [[ -n "$AUTH_STATUS" ]]; then
  auth_label="$(format_auth_label "$AUTH_STATUS" "$AUTH_ACTION" "$AUTH_MESSAGE")"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  cached_lr="${ORIGINAL_LAST_REFRESH:-unknown}"
  offline_hint=""
  [[ -n "$AUTH_PULL_REASON" ]] && offline_hint="; ${AUTH_PULL_REASON}"
  if ((HAS_LOCAL_AUTH)) && ((LOCAL_AUTH_IS_FRESH)); then
    auth_label="using cached auth (api offline${offline_hint}; last_refresh ${cached_lr})"
  elif ((HAS_LOCAL_AUTH)) && ((HOST_IS_SECURE)) && ((LOCAL_AUTH_IS_RECENT)); then
    auth_label="using cached auth (secure host; api offline${offline_hint}; last_refresh ${cached_lr})"
  elif ((HAS_LOCAL_AUTH)); then
    auth_label="cached auth stale (api offline${offline_hint}; last_refresh ${cached_lr})"
  else
    auth_label="auth unavailable (api offline${offline_hint})"
  fi
elif [[ "$AUTH_PULL_STATUS" == "insecure" ]]; then
  auth_label="insecure host window closed"
elif [[ "$AUTH_PULL_STATUS" == "insecure-denied" ]]; then
  auth_label="insecure host approval denied"
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if ((HAS_VALID_LOCAL_AUTH)); then
    auth_label="concurrent guard active; using local auth.json"
  else
    auth_label="concurrent guard active; local auth.json missing or invalid"
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_label="auth sync failed"
fi

auth_tone="yellow"
case "$AUTH_STATUS" in
  valid | "")
    [[ "$AUTH_PULL_STATUS" == "ok" ]] && auth_tone="green"
    ;;
  outdated | missing | upload_required)
    if ((HOST_IS_SECURE)); then
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
  if ((HAS_LOCAL_AUTH)) && ((LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT))); then
    auth_tone="yellow"
  else
    auth_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if ((HAS_VALID_LOCAL_AUTH)); then
    auth_tone="yellow"
  else
    auth_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  auth_tone="red"
fi

# ── Runner status ─────────────────────────────────────────────

runner_label=""
runner_tone="yellow"
runner_enabled_flag=0
[[ "$RUNNER_ENABLED" == "1" ]] && runner_enabled_flag=1
if ((runner_enabled_flag)) || [[ -n "$RUNNER_STATE$RUNNER_LAST_OK$RUNNER_LAST_FAIL" ]]; then
  state="$(lowercase "$RUNNER_STATE")"
  last_ok_rel="$(format_relative_iso "$RUNNER_LAST_OK" 2>/dev/null || true)"
  last_fail_rel="$(format_relative_iso "$RUNNER_LAST_FAIL" 2>/dev/null || true)"
  if ((runner_enabled_flag)); then
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
          ((age_seconds < 0)) && age_seconds=$((-age_seconds))
          if ((age_seconds <= 90)); then
            runner_label="runner verified recently"
          else
            runner_label="runner verified ${last_ok_rel}"
          fi
          if ((age_seconds >= RUNNER_STALE_CRIT_SECONDS)); then
            runner_tone="red"
            runner_label+=" (stale)"
          elif ((age_seconds >= RUNNER_STALE_WARN_SECONDS)); then
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

# ── Skills status ─────────────────────────────────────────────

skill_label="skills via MCP"
skill_tone="green"
if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && ((SKILL_REMOVED > 0)); then
  skill_label+=" (${SKILL_REMOVED} local legacy paths removed)"
fi

# ── CLAUDE.md (agents) status ─────────────────────────────────

agents_label="CLAUDE.md sync skipped"
agents_tone="yellow"
if [[ "$AGENTS_SYNC_STATUS" == "ok" ]]; then
  case "$AGENTS_STATE" in
    updated)
      agents_label="CLAUDE.md updated"
      agents_tone="green"
      ;;
    unchanged)
      agents_label="CLAUDE.md current"
      agents_tone="green"
      ;;
    missing)
      agents_label="CLAUDE.md cleared"
      agents_tone="yellow"
      ;;
    *)
      agents_label="CLAUDE.md synced"
      agents_tone="green"
      ;;
  esac
elif [[ "$AGENTS_SYNC_STATUS" == "missing-config" ]]; then
  agents_label="CLAUDE.md sync config missing"
  agents_tone="red"
elif [[ "$AGENTS_SYNC_STATUS" == "no-python" ]]; then
  agents_label="CLAUDE.md sync requires python3"
  agents_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "offline" ]]; then
  agents_label="CLAUDE.md sync unavailable"
  if [[ -n "$AGENTS_SYNC_REASON" ]]; then
    agents_label+=" (${AGENTS_SYNC_REASON})"
  fi
  agents_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  agents_label="CLAUDE.md sync failed"
  agents_tone="red"
fi

# ── settings.json (config) status ─────────────────────────────

config_label="settings.json sync skipped"
config_tone="yellow"
if [[ "$CONFIG_SYNC_STATUS" == "ok" ]]; then
  case "$CONFIG_STATE" in
    updated)
      config_label="settings.json updated"
      config_tone="green"
      ;;
    unchanged)
      config_label="settings.json current"
      config_tone="green"
      ;;
    missing)
      config_label="settings.json cleared"
      config_tone="yellow"
      ;;
    *)
      config_label="settings.json synced"
      config_tone="green"
      ;;
  esac
elif [[ "$CONFIG_SYNC_STATUS" == "missing-config" ]]; then
  config_label="settings.json sync config missing"
  config_tone="red"
elif [[ "$CONFIG_SYNC_STATUS" == "no-python" ]]; then
  config_label="settings.json sync requires python3"
  config_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "offline" ]]; then
  config_label="settings.json sync unavailable"
  if [[ -n "$CONFIG_SYNC_REASON" ]]; then
    config_label+=" (${CONFIG_SYNC_REASON})"
  fi
  config_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  config_label="settings.json sync failed"
  config_tone="red"
fi

# ── Quota (spend-based) ──────────────────────────────────────
# Claude uses a single spend pool, not ChatGPT lanes.

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

quota_warn_threshold=$((quota_limit - 10))
if ((quota_warn_threshold < 0)); then
  quota_warn_threshold=0
fi

quota_reasons=()
quota_warnings=()

if [[ -n "$CLAUDE_SPEND_USED" && -n "$CLAUDE_SPEND_LIMIT" ]] \
   && [[ "$CLAUDE_SPEND_LIMIT" != "0" && "$CLAUDE_SPEND_LIMIT" != "null" ]]; then
  spend_pct=$(awk "BEGIN { printf \"%.0f\", ($CLAUDE_SPEND_USED / $CLAUDE_SPEND_LIMIT) * 100 }" 2>/dev/null || echo "0")

  if [[ "$spend_pct" =~ ^[0-9]+$ ]]; then
    if ((spend_pct >= quota_limit)); then
      reason="spend quota reached (\$${CLAUDE_SPEND_USED} of \$${CLAUDE_SPEND_LIMIT}, ${spend_pct}%)"
      quota_reasons+=("$reason")
    elif ((spend_pct >= quota_warn_threshold)); then
      reason="spend quota high (\$${CLAUDE_SPEND_USED} of \$${CLAUDE_SPEND_LIMIT}, ${spend_pct}%)"
      quota_warnings+=("$reason")
    fi
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

# ── Command actions ───────────────────────────────────────────

command_actions=()
if ((claude_update_attempted)); then command_actions+=("claude"); fi
if ((wrapper_update_attempted)); then command_actions+=("wrapper"); fi
should_flag_auth=1
if ((!HOST_IS_SECURE)) && [[ "$AUTH_PULL_STATUS" == "ok" ]] && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  should_flag_auth=0
fi
if ((should_flag_auth)) && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ || "$AUTH_ACTION" == "store" ]]; then command_actions+=("auth"); fi
command_label="launching claude"
if ((${#command_actions[@]})); then
  command_label="updating $(human_join "${command_actions[@]}")"
fi

# ── Result parts ──────────────────────────────────────────────

result_parts=()
if ((claude_updated)); then
  result_parts+=("claude updated")
elif ((claude_update_failed)); then
  result_parts+=("claude update failed")
else
  result_parts+=("claude $(lowercase "$claude_status_label")")
fi
if ((wrapper_updated)); then
  result_parts+=("wrapper updated")
elif ((wrapper_update_failed)); then
  result_parts+=("wrapper update failed")
else
  result_parts+=("wrapper $(lowercase "$wrapper_status_label")")
fi
if [[ -n "$AUTH_STATUS" ]]; then
  if ((!HOST_IS_SECURE)) && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
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
  if ((HAS_LOCAL_AUTH)) && ((LOCAL_AUTH_IS_FRESH)); then
    result_parts+=("auth cached (${offline_note})")
  elif ((HAS_LOCAL_AUTH)) && ((HOST_IS_SECURE)) && ((LOCAL_AUTH_IS_RECENT)); then
    result_parts+=("auth cached (secure host; ${offline_note})")
  elif ((HAS_LOCAL_AUTH)); then
    result_parts+=("auth stale (${offline_note})")
  else
    result_parts+=("auth unavailable (${offline_note})")
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if ((HAS_VALID_LOCAL_AUTH)); then
    result_parts+=("auth local-only (active clx run)")
  else
    result_parts+=("auth unavailable (active clx run; local auth invalid)")
  fi
elif [[ "$AUTH_PULL_STATUS" != "ok" ]]; then
  result_parts+=("auth unavailable")
fi
skill_result="skills via MCP"
if [[ "$SKILL_REMOVED" =~ ^[0-9]+$ ]] && ((SKILL_REMOVED > 0)); then
  skill_result+="; cleanup removed ${SKILL_REMOVED}"
fi
result_parts+=("$skill_result")
if [[ "$AGENTS_SYNC_STATUS" == "ok" ]]; then
  case "$AGENTS_STATE" in
    updated)
      result_parts+=("CLAUDE.md updated")
      ;;
    unchanged)
      result_parts+=("CLAUDE.md current")
      ;;
    missing)
      result_parts+=("CLAUDE.md cleared")
      ;;
    *)
      result_parts+=("CLAUDE.md synced")
      ;;
  esac
elif [[ "$AGENTS_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("CLAUDE.md config missing")
elif [[ "$AGENTS_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("CLAUDE.md python missing")
elif [[ "$AGENTS_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$AGENTS_SYNC_REASON" ]]; then
    result_parts+=("CLAUDE.md offline (${AGENTS_SYNC_REASON})")
  else
    result_parts+=("CLAUDE.md offline")
  fi
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  result_parts+=("CLAUDE.md sync failed")
fi
if [[ "$CONFIG_SYNC_STATUS" == "ok" ]]; then
  case "$CONFIG_STATE" in
    updated)
      result_parts+=("settings.json updated")
      ;;
    unchanged)
      result_parts+=("settings.json current")
      ;;
    missing)
      result_parts+=("settings.json cleared")
      ;;
    *)
      result_parts+=("settings.json synced")
      ;;
  esac
elif [[ "$CONFIG_SYNC_STATUS" == "missing-config" ]]; then
  result_parts+=("settings.json config missing")
elif [[ "$CONFIG_SYNC_STATUS" == "no-python" ]]; then
  result_parts+=("settings.json python missing")
elif [[ "$CONFIG_SYNC_STATUS" == "offline" ]]; then
  if [[ -n "$CONFIG_SYNC_REASON" ]]; then
    result_parts+=("settings.json offline (${CONFIG_SYNC_REASON})")
  else
    result_parts+=("settings.json offline")
  fi
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  result_parts+=("settings.json sync failed")
fi
if ((QUOTA_BLOCKED)); then
  result_parts+=("${QUOTA_BLOCK_REASON:-quota reached}")
fi
result_label="$(human_join "${result_parts[@]}")"

# ── Usage summary ─────────────────────────────────────────────

usage_summary=""
if [[ -n "${last_usage_payload:-}" ]]; then
  usage_summary="$(parse_claude_usage_summary "$last_usage_payload")"
fi

# ── Status tones ──────────────────────────────────────────────

claude_tone="green"
case "$(lowercase "$claude_status_label")" in
  update\ available | check\ skipped | update\ skipped | deferred)
    claude_tone="yellow"
    ;;
  blocked\ on\ ssh)
    claude_tone="red"
    ;;
  update\ failed | api\ unavailable)
    claude_tone="red"
    ;;
esac
((claude_update_failed)) && claude_tone="red"

wrapper_tone="green"
case "$(lowercase "$wrapper_status_label")" in
  update\ available | update\ skipped | check\ skipped)
    wrapper_tone="yellow"
    ;;
  update\ failed)
    wrapper_tone="red"
    ;;
esac
((wrapper_update_failed)) && wrapper_tone="red"

result_tone="green"
if ((claude_update_failed)) || ((wrapper_update_failed)) || { [[ "$AUTH_PULL_STATUS" != "ok" ]] && [[ "$AUTH_PULL_STATUS" != "offline" ]] && [[ "$AUTH_PULL_STATUS" != "concurrent" ]]; }; then
  result_tone="red"
elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
  if ((HAS_LOCAL_AUTH)) && ((LOCAL_AUTH_IS_FRESH || (HOST_IS_SECURE && LOCAL_AUTH_IS_RECENT))); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$AUTH_PULL_STATUS" == "concurrent" ]]; then
  if ((HAS_VALID_LOCAL_AUTH)); then
    result_tone="yellow"
  else
    result_tone="red"
  fi
elif [[ "$(lowercase "$claude_status_label")" == "blocked on ssh" ]]; then
  result_tone="red"
elif [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]]; then
  result_tone="yellow"
elif [[ "$(lowercase "$claude_status_label")" == "update available" ]] || [[ "$(lowercase "$wrapper_status_label")" == "update available" ]]; then
  result_tone="yellow"
elif [[ "$AGENTS_SYNC_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$AGENTS_SYNC_STATUS" != "ok" && "$AGENTS_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif [[ "$CONFIG_SYNC_STATUS" == "error" ]]; then
  result_tone="red"
elif [[ "$CONFIG_SYNC_STATUS" != "ok" && "$CONFIG_SYNC_STATUS" != "skip" ]]; then
  result_tone="yellow"
elif ((QUOTA_WARNING)); then
  result_tone="yellow"
elif ((QUOTA_BLOCKED)); then
  result_tone="red"
fi

# ── Insecure compact ─────────────────────────────────────────

insecure_compact_ok=0
if ((!HOST_IS_SECURE)); then
  if ((!claude_updated)) && ((!claude_update_failed)) \
    && ((!wrapper_updated)) && ((!wrapper_update_failed)) \
    && [[ "$AUTH_PULL_STATUS" == "ok" ]] \
    && [[ "$AUTH_STATUS" =~ ^(outdated|missing|upload_required)$ ]] \
    && [[ "$SKILL_SYNC_STATUS" == "mcp" ]] \
    && [[ "$AGENTS_SYNC_STATUS" == "ok" ]] \
    && [[ "$AGENTS_STATE" == "unchanged" ]] \
    && [[ "$CONFIG_SYNC_STATUS" == "ok" ]] \
    && [[ "$CONFIG_STATE" == "unchanged" ]]; then
    insecure_compact_ok=1
  fi
fi

# ── Ready label & branding ────────────────────────────────────

if ((!HOST_IS_SECURE)); then
  if ((insecure_compact_ok)); then
    result_label="Synced on insecure host; auth refreshed."
  elif [[ "$result_tone" == "green" ]]; then
    result_label="Ready on insecure host."
  fi
elif [[ "$result_tone" == "green" && "${command_tone:-}" != "red" && "$auth_tone" == "green" && "$claude_tone" == "green" && "$wrapper_tone" == "green" ]]; then
  result_label="Ready (Claude go brrrr)."
fi

# ── Command tone ──────────────────────────────────────────────

command_tone=""
if ((${#command_actions[@]})); then
  command_tone="yellow"
fi
if ((QUOTA_WARNING)); then
  command_tone="yellow"
fi
if ((QUOTA_BLOCKED)); then
  command_tone="red"
fi
