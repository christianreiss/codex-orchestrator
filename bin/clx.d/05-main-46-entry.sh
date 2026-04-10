# ── CLX Entry Logic ───────────────────────────────────────────
# Wrapper restart after self-update, auth launch gating, quota enforcement.

clx_entry_gate() {
  # ── Wrapper restart after self-update ─────────────────────────
  if ((wrapper_updated)) && ((!CLAUDE_EXIT_AFTER_UPDATE)) && ((!CLAUDE_STATUS_ONLY)) && ((!CLAUDE_DOCTOR_ONLY)); then
    if [[ "${CLAUDE_WRAPPER_RESTARTED:-0}" == "1" ]]; then
      rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
      log_error "Wrapper update loop detected; aborting."
      exit 1
    fi
    log_warn "Wrapper updated; restarting clx to load the new wrapper."
    if ! declare -p CLAUDE_ORIGINAL_ARGC >/dev/null 2>&1 || [[ ! "${CLAUDE_ORIGINAL_ARGC:-}" =~ ^[0-9]+$ ]]; then
      CLAUDE_ORIGINAL_ARGC=0
    fi
    if ! declare -p CLAUDE_ORIGINAL_ARGS >/dev/null 2>&1; then
      CLAUDE_ORIGINAL_ARGS=()
    fi
    rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
    if ((CLAUDE_ORIGINAL_ARGC > 0)); then
      CLAUDE_SKIP_MOTD=1 CLAUDE_WRAPPER_RESTARTED=1 exec "$CLX_SCRIPT_REAL" "${CLAUDE_ORIGINAL_ARGS[@]}"
    fi
    CLAUDE_SKIP_MOTD=1 CLAUDE_WRAPPER_RESTARTED=1 exec "$CLX_SCRIPT_REAL"
  fi

  # ── Auth launch gating ──────────────────────────────────────
  local AUTH_LAUNCH_ALLOWED=0
  local AUTH_LAUNCH_REASON=""
  case "$AUTH_PULL_STATUS" in
    ok)
      AUTH_LAUNCH_ALLOWED=1
      ;;
    offline)
      local offline_launch_hint=""
      [[ -n "$AUTH_PULL_REASON" ]] && offline_launch_hint=" (${AUTH_PULL_REASON})"
      if ((HAS_LOCAL_AUTH)) && ((LOCAL_AUTH_IS_FRESH)); then
        AUTH_LAUNCH_ALLOWED=1
        AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; using cached credentials"
      elif ((HAS_LOCAL_AUTH)) && ((HOST_IS_SECURE)); then
        AUTH_LAUNCH_ALLOWED=1
        AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; secure host using cached credentials"
      elif ((HAS_LOCAL_AUTH)); then
        AUTH_LAUNCH_REASON="API offline${offline_launch_hint}; cached credentials older than allowed window"
      else
        AUTH_LAUNCH_REASON="API offline${offline_launch_hint} and no cached credentials"
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
      if ((HAS_VALID_LOCAL_AUTH)); then
        AUTH_LAUNCH_ALLOWED=1
      elif ((HAS_LOCAL_AUTH)); then
        AUTH_LAUNCH_REASON="Active clx run detected and local credentials are invalid."
      else
        AUTH_LAUNCH_REASON="Active clx run detected and no local credentials are available."
      fi
      ;;
    fail)
      AUTH_LAUNCH_REASON="Auth sync failed; check API connectivity."
      ;;
    skip)
      # No sync URL configured; allow launch with whatever credentials exist.
      AUTH_LAUNCH_ALLOWED=1
      ;;
    *)
      AUTH_LAUNCH_REASON="Auth unavailable; fix sync before retrying."
      ;;
  esac

  # ── Quota enforcement ───────────────────────────────────────
  if ((AUTH_LAUNCH_ALLOWED == 1)) && ((CLAUDE_WANTS_RUN)) && ((QUOTA_BLOCKED)); then
    if ((QUOTA_HARD_FAIL)); then
      AUTH_LAUNCH_ALLOWED=0
      AUTH_LAUNCH_REASON="${QUOTA_BLOCK_REASON:-Claude quota reached}"
    else
      log_warn "Quota warn mode; continuing."
    fi
  fi

  if ((QUOTA_WARNING)) && ((AUTH_LAUNCH_ALLOWED == 1)) && ((CLAUDE_WANTS_RUN)); then
    log_warn "Claude quota near limit: ${QUOTA_WARNING_REASON:-see usage above}."
  fi

  # ── Deny launch if not allowed ──────────────────────────────
  if ((AUTH_LAUNCH_ALLOWED == 0)); then
    rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
    log_error "${AUTH_LAUNCH_REASON:-Auth unavailable; refusing to start Claude Code. Re-run after fixing API key or provisioning auth.}"
    exit 1
  elif [[ "$AUTH_PULL_STATUS" == "offline" ]]; then
    log_warn "${AUTH_LAUNCH_REASON} (last_refresh ${ORIGINAL_LAST_REFRESH:-unknown})."
  fi

  # ── Gate: skip launch if not requested ──────────────────────
  if ((CLAUDE_WANTS_RUN == 0)); then
    rm -f "$CLX_LOCK_FILE" 2>/dev/null || true
    exit 0
  fi
}
