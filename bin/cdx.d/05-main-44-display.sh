
  concurrent_compact_summary=0
  concurrent_compact_note=""
  concurrent_compact_tone="yellow"
  if (( CDX_ACTIVE_RUN_DETECTED )) && (( ! CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    concurrent_compact_summary=1
    if (( HAS_VALID_LOCAL_AUTH )); then
      concurrent_compact_note="Using local auth.json."
    elif (( HAS_LOCAL_AUTH )); then
      concurrent_compact_note="Local auth.json is invalid."
      concurrent_compact_tone="red"
    else
      concurrent_compact_note="Local auth.json is missing."
      concurrent_compact_tone="red"
    fi
  fi

  if (( ! wrapper_updated || CODEX_STATUS_ONLY || CODEX_DOCTOR_ONLY )); then
    row_label_width_default="$ROW_LABEL_WIDTH"
    summary_row_labels=("Health" "Versions" "Usage" "Quota" "Result" "Concurrent" "Other lane")
    ROW_LABEL_WIDTH="$(compute_row_label_width "${summary_row_labels[@]}")"

    if (( CODEX_MINIMAL_OUTPUT )); then
      minimal_health_line="api=${api_tone} auth=${auth_tone} skills=${skill_tone} codex=${codex_tone} wrapper=${wrapper_tone}"
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
      print_boot_screen
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
