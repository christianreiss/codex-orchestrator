
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
