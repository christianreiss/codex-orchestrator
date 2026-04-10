# ── CLX Display ───────────────────────────────────────────────
# Concurrent session display, status/doctor gates, minimal output.

clx_display() {
  local concurrent_compact_summary=0
  local concurrent_compact_note=""
  if ((CLX_ACTIVE_RUN_DETECTED)) && ((!CLAUDE_CONCURRENT_SYNC_OVERRIDE)); then
    concurrent_compact_summary=1
    if ((HAS_VALID_LOCAL_AUTH)); then
      concurrent_compact_note="Using local credentials."
    elif ((HAS_LOCAL_AUTH)); then
      concurrent_compact_note="Local credentials are invalid."
    else
      concurrent_compact_note="Local credentials are missing."
    fi
  fi

  if ((CLAUDE_STATUS_ONLY)); then
    clx_status
    if [[ "$result_tone" == "red" ]]; then
      rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
      exit 1
    fi
    rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
    exit 0
  fi

  if ((CLAUDE_DOCTOR_ONLY)); then
    print_doctor_report
    if ((DOCTOR_FAILURES > 0)) || [[ "$result_tone" == "red" ]]; then
      rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
      exit 1
    fi
    rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
    exit 0
  fi

  if ((CLAUDE_MINIMAL_OUTPUT)); then
    local minimal_health_line="api=${api_tone} auth=${auth_tone} skills=${skill_tone} claude=${claude_tone} wrapper=${wrapper_tone}"
    if [[ -n "${agents_label:-}" ]]; then
      minimal_health_line+=" agents=${agents_tone}"
    fi
    if [[ -n "${config_label:-}" ]]; then
      minimal_health_line+=" config=${config_tone}"
    fi
    if ((QUOTA_BLOCKED)); then
      minimal_health_line+=" quota=blocked"
    elif ((QUOTA_WARNING)); then
      minimal_health_line+=" quota=warn"
    fi
    local minimal_result_line="$result_label"
    log_info "Health: ${minimal_health_line}"
    log_info "Result: ${minimal_result_line}"
  else
    print_boot_screen
  fi

  if ((concurrent_compact_summary)); then
    log_info "Concurrent session detected. ${concurrent_compact_note}"
  fi
}
