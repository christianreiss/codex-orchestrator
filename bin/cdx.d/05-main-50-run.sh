cleanup() {
  local exit_status=$?
  trap - EXIT
  if (( ! CDX_ACTIVE_RUN_DETECTED )) || (( CODEX_CONCURRENT_SYNC_OVERRIDE )); then
    push_slash_commands_if_changed || true
    push_skills_if_changed || true
  fi
  if (( CODEX_COMMAND_STARTED )) && (( SYNC_PUSH_COMPLETED == 0 )); then
    push_auth_if_changed "push" || true
  fi
  if (( PURGE_AUTH_AFTER_RUN )) && (( CODEX_COMMAND_STARTED )) && (( ! CDX_ACTIVE_RUN_DETECTED )) && [[ -f "$HOME/.codex/auth.json" ]]; then
    remove_path "$HOME/.codex/auth.json" "auth.json (insecure host)"
  fi
  print_run_exit_footer || true
  release_run_lock_if_held || true
  exit "$exit_status"
}
trap cleanup EXIT

if (( AUTH_LAUNCH_ALLOWED == 0 )); then
  exit 1
fi

apply_otel_env_from_config() {
  if [[ ! -f "$CONFIG_PATH" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  local line key val
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    key="${line%%=*}"
    val="${line#*=}"
    case "$key" in
      OTEL_*|CODEX_OTEL_LOG_USER_PROMPT)
        export "$key=$val"
        ;;
    esac
  done < <(otel_env_from_config_python 2>/dev/null || true)
}

apply_otel_env_from_config

codex_cli_args_from_config_python() {
  python3 - "$CONFIG_PATH" <<'PY'
import re, sys

path = sys.argv[1]
try:
    raw = open(path, "r", encoding="utf-8", errors="ignore").read()
except Exception:
    sys.exit(0)

def find_block(name: str) -> str:
    m = re.search(r'(?m)^\\[' + re.escape(name) + r'\\]\\s*$', raw)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r'(?m)^\\[', raw[start:])
    end = start + (m2.start() if m2 else len(raw[start:]))
    return raw[start:end]

block = find_block("security")
if not block:
    sys.exit(0)

m = re.search(r'(?m)^\\s*dangerously_bypass_approvals_and_sandbox\\s*=\\s*(true|false)\\s*$', block)
if m and m.group(1) == "true":
    print("--dangerously-bypass-approvals-and-sandbox")
PY
}

apply_codex_cli_toggles_from_config() {
  if [[ ! -f "$CONFIG_PATH" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  local line
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    case "$line" in
      --dangerously-bypass-approvals-and-sandbox)
        set -- "$line" "$@"
        ;;
    esac
  done < <(codex_cli_args_from_config_python 2>/dev/null || true)
}

apply_codex_cli_toggles_from_config

detect_script_flags() {
  local help_output
  SCRIPT_SUPPORTS_C=0
  help_output="$(script --help 2>&1 || script -h 2>&1 || true)"
  if printf '%s' "$help_output" | grep -Eq '(^|[[:space:]])-c([[:space:],]|$)'; then
    SCRIPT_SUPPORTS_C=1
  fi
  if printf '%s' "$help_output" | grep -Eq '(^|[[:space:]])-F([[:space:],]|$)'; then
    SCRIPT_FLAGS="-qFe"
  elif printf '%s' "$help_output" | grep -Eq '(^|[[:space:]])-f([[:space:],]|$)'; then
    SCRIPT_FLAGS="-qef"
  else
    SCRIPT_FLAGS="-qe"
  fi
}

run_codex_command() {
  local tmp_output status
  tmp_output="$(mktemp)"
  set +e
  local prompt_toolkit_no_cpr_added=0
  local pty_auto_disable_file="$HOME/.codex/.cdx_no_pty"
  local pty_tty_error=0
  # If we're not connected to a real TTY (common on some odd SSH/VM setups),
  # forcing prompt-toolkit cursor position reports can hard-fail.
  if [[ -z "${PROMPT_TOOLKIT_NO_CPR:-}" ]] && [[ ! -t 0 || ! -t 1 ]]; then
    export PROMPT_TOOLKIT_NO_CPR=1
    prompt_toolkit_no_cpr_added=1
  fi

  if [[ -t 0 && -t 1 ]]; then
    local cmd_line=("$CODEX_REAL_BIN" "$@")
    if [[ "$CODEX_NO_PTY" == "1" ]]; then
      # Preserve interactive TTY behavior when PTY capture is explicitly disabled.
      "${cmd_line[@]}"
      status=$?
    elif [[ "${CODEX_FORCE_PTY:-0}" != "1" && -f "$pty_auto_disable_file" ]]; then
      # Auto-detected incompatible PTY host; run direct unless explicitly overridden.
      "${cmd_line[@]}"
      status=$?
    else
      if [[ -z "${PROMPT_TOOLKIT_NO_CPR:-}" ]]; then
        export PROMPT_TOOLKIT_NO_CPR=1
        prompt_toolkit_no_cpr_added=1
      fi
      if [[ "$CODEX_NO_SCRIPT" != "1" ]] && command -v script >/dev/null 2>&1; then
        # Use script to keep a PTY and capture output to a typescript file while streaming to the real TTY.
        local cmd_str
        cmd_str="$(printf '%q ' "${cmd_line[@]}")"
        detect_script_flags
        if (( SCRIPT_SUPPORTS_C )); then
          script $SCRIPT_FLAGS "$tmp_output" -c "$cmd_str"
        else
          script $SCRIPT_FLAGS "$tmp_output" "${cmd_line[@]}"
        fi
        status=$?
      elif command -v python3 >/dev/null 2>&1; then
        # Fallback PTY using Python's pty module when script is unavailable.
        status=0
        python3 - "$tmp_output" "${cmd_line[@]}" <<'PY'
import os, sys, pty
log_path = sys.argv[1]
cmd = sys.argv[2:]
with open(log_path, "wb") as log:
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    try:
        while True:
            try:
                data = os.read(fd, 1024)
            except OSError:
                break
            if not data:
                break
            os.write(sys.stdout.fileno(), data)
            log.write(data)
            log.flush()
    except KeyboardInterrupt:
        pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status))
PY
        status=$?
      else
        # Last-resort: run directly to preserve TTY; no tee (token usage may be skipped).
        "${cmd_line[@]}"
        status=$?
      fi

      if [[ -f "$tmp_output" ]] && grep -Eiq '(stdout is not a terminal|stdin is not a terminal|stdin/stderr is not a TTY|stdin is not a tty|stdout is not a tty)' "$tmp_output"; then
        pty_tty_error=1
      fi
      # Only retry when the PTY run itself failed and looks TTY-incompatible.
      if (( pty_tty_error )) && [[ ${status:-1} -ne 0 ]]; then
        mkdir -p "$(dirname "$pty_auto_disable_file")" >/dev/null 2>&1 || true
        {
          printf 'detected_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
          printf 'wrapper_version=%s\n' "${WRAPPER_VERSION:-unknown}"
        } > "$pty_auto_disable_file" 2>/dev/null || true
        log_warn "PTY capture looks incompatible on this host; auto-disabling PTY capture. Remove $pty_auto_disable_file or set CODEX_FORCE_PTY=1 to retry."
        "${cmd_line[@]}"
        status=$?
      fi
    fi
  else
    # Non-TTY stdout should not rewrite user intent (for example forcing `exec`).
    # For interactive no-arg launches, fail fast with an explicit non-interactive hint.
    if [[ ! -t 1 ]]; then
      if (( $# == 0 )); then
        log_error "stdout is not a TTY; interactive launch requires a terminal."
        log_error "Use: cdx --execute \"<prompt>\" [codex args...]"
        status=1
      else
        "$CODEX_REAL_BIN" "$@" 2>&1 | tee "$tmp_output"
        status=${PIPESTATUS[0]}
      fi
    else
      "$CODEX_REAL_BIN" "$@" 2>&1 | tee "$tmp_output"
      status=${PIPESTATUS[0]}
    fi
  fi
  if (( prompt_toolkit_no_cpr_added )); then
    unset PROMPT_TOOLKIT_NO_CPR
  fi
  set -e
  if [[ -f "$tmp_output" ]]; then
    send_token_usage_if_present "$tmp_output"
    rm -f "$tmp_output"
  fi
  return "$status"
}

codex_args_include_profile_or_model() {
  local arg=""
  for arg in "$@"; do
    case "$arg" in
      --model|--profile|--model=*|--profile=*)
        return 0
        ;;
    esac
  done
  return 1
}

user_selected_profile_or_model=0
if codex_args_include_profile_or_model "$@"; then
  user_selected_profile_or_model=1
fi
if [[ -n "${CODEX_PROFILE_CANDIDATE:-}" ]]; then
  user_selected_profile_or_model=1
fi

if [[ -n "${CODEX_PROFILE_CANDIDATE:-}" ]]; then
  candidate="$CODEX_PROFILE_CANDIDATE"
  CODEX_PROFILE_CANDIDATE=""
  if config_has_profile "$candidate"; then
    set -- --profile "$candidate" "$@"
  else
    set -- "$candidate" "$@"
  fi
fi

lane_selector_profile=""
lane_selector_model=""
CODEX_EFFECTIVE_LANE_SELECTOR=""
apply_lane_selector=0
if [[ "$CODEX_EFFECTIVE_LANE_SOURCE" == command* || "$CODEX_EFFECTIVE_LANE_SOURCE" == host* ]]; then
  apply_lane_selector=1
fi
if (( apply_lane_selector )) && [[ "$CODEX_EFFECTIVE_LANE" == "normal" || "$CODEX_EFFECTIVE_LANE" == "spark" ]]; then
  if config_has_profile "$CODEX_EFFECTIVE_LANE"; then
    lane_selector_profile="$CODEX_EFFECTIVE_LANE"
    CODEX_EFFECTIVE_LANE_SELECTOR="profile:${lane_selector_profile}"
  elif [[ "$CODEX_EFFECTIVE_LANE" == "spark" ]]; then
    lane_selector_model="gpt-5.3-codex-spark"
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${lane_selector_model}"
  else
    lane_selector_model="gpt-5.3-codex"
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${lane_selector_model}"
  fi
fi

if (( user_selected_profile_or_model )) && (( CODEX_LANE_USER_SET )); then
  log_warn "Lane override requested, but explicit --model/--profile args were provided; honoring explicit Codex args."
fi

injected_model=0
if (( ! user_selected_profile_or_model )) && [[ -n "$lane_selector_profile" ]]; then
  set -- --profile "$lane_selector_profile" "$@"
elif (( ! user_selected_profile_or_model )) && [[ -n "$lane_selector_model" ]]; then
  set -- --model "$lane_selector_model" "$@"
  injected_model=1
elif (( ! user_selected_profile_or_model )) && [[ -n "$CODEX_HOST_MODEL" ]]; then
  set -- --model "$CODEX_HOST_MODEL" "$@"
  injected_model=1
  if [[ -z "$CODEX_EFFECTIVE_LANE_SELECTOR" ]]; then
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${CODEX_HOST_MODEL}"
  fi
fi

if (( ! user_selected_profile_or_model )) && (( injected_model )) && [[ -n "$CODEX_HOST_REASONING_EFFORT" ]]; then
  set -- --config "model_reasoning_effort=${CODEX_HOST_REASONING_EFFORT}" "$@"
fi

CODEX_COMMAND_STARTED=1
if run_codex_command "$@"; then
  cmd_status=0
else
  cmd_status=$?
fi
push_auth_if_changed "push" || true
exit "$cmd_status"
