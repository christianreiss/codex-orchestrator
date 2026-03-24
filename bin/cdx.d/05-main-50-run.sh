stop_codex_ipv4_proxy() {
  local proxy_pid="${CODEX_IPV4_PROXY_PID:-}"
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CODEX_IPV4_PROXY_DIR:-}" ]] && [[ -d "$CODEX_IPV4_PROXY_DIR" ]]; then
    rm -rf "$CODEX_IPV4_PROXY_DIR" >/dev/null 2>&1 || true
  fi
  CODEX_IPV4_PROXY_PID=""
  CODEX_IPV4_PROXY_DIR=""
  CODEX_IPV4_PROXY_URL=""
}

start_codex_ipv4_proxy() {
  if [[ "$CODEX_FORCE_IPV4" != "1" ]]; then
    return 1
  fi
  if [[ -n "${CODEX_IPV4_PROXY_URL:-}" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 is unavailable; Codex child traffic cannot be forced through the local IPv4 proxy."
    return 1
  fi

  local state_dir port_file port=""
  state_dir="$(mktemp -d "${TMPDIR:-/tmp}/cdx-ipv4-proxy.XXXXXX")"
  port_file="$state_dir/port"
  CODEX_IPV4_PROXY_DIR="$state_dir"

  CODEX_IPV4_PROXY_DIR="$state_dir" python3 -u - <<'PY' >/dev/null 2>&1 &
import os
namespace = {}
exec(os.environ["CODEX_PY_IPV4_PROXY_UTIL"], namespace)
raise SystemExit(namespace["main"]())
PY
  CODEX_IPV4_PROXY_PID="$!"

  local _i=0
  for ((_i=0; _i<50; _i++)); do
    if [[ -f "$port_file" ]]; then
      port="$(tr -d '[:space:]' < "$port_file")"
      break
    fi
    if ! kill -0 "$CODEX_IPV4_PROXY_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if [[ -z "$port" ]] || ! [[ "$port" =~ ^[0-9]+$ ]]; then
    log_warn "failed to start the local IPv4 proxy; continuing without forcing Codex child traffic to IPv4."
    stop_codex_ipv4_proxy
    return 1
  fi

  CODEX_IPV4_PROXY_URL="http://127.0.0.1:${port}"
  return 0
}

cleanup() {
  local exit_status=$?
  trap - EXIT
  stop_codex_ipv4_proxy || true
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
    # Allow an optional inline TOML comment after the closing bracket,
    # e.g. `[otel] # my settings` is valid TOML and must still be matched.
    m = re.search(r'(?m)^\[' + re.escape(name) + r'\]\s*(?:#.*)?$', raw)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r'(?m)^\[', raw[start:])
    end = start + (m2.start() if m2 else len(raw[start:]))
    return raw[start:end]

block = find_block("security")
if not block:
    sys.exit(0)

m = re.search(r'(?m)^\s*dangerously_bypass_approvals_and_sandbox\s*=\s*(true|false)\s*$', block)
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

ensure_project_path_trusted_in_config() {
  local project_path="${1-}"
  if [[ -z "$project_path" ]]; then
    return 0
  fi
  if [[ "$project_path" != /* ]]; then
    return 0
  fi
  if [[ "$project_path" == *$'\n'* || "$project_path" == *$'\r'* ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  CODEX_TRUST_PATH="$project_path" python3 - "$CONFIG_PATH" <<'PY'
import os
import re
import sys
from pathlib import Path

config_path = Path(sys.argv[1])
project_path = os.environ.get("CODEX_TRUST_PATH", "").strip()
if not project_path or not project_path.startswith("/"):
    raise SystemExit(0)
if any(ord(ch) < 32 or ord(ch) == 127 for ch in project_path):
    raise SystemExit(0)

table = '[projects."' + project_path.replace("\\", "\\\\").replace('"', '\\"') + '"]'
trust_line = 'trust_level = "trusted"'

try:
    original = config_path.read_text(encoding="utf-8")
except FileNotFoundError:
    original = ""
except Exception:
    raise SystemExit(0)

lines = original.splitlines()
changed = False


def is_header(line: str) -> bool:
    stripped = line.strip()
    return stripped.startswith("[") and stripped.endswith("]")


table_index = None
for idx, line in enumerate(lines):
    if line.strip() == table:
        table_index = idx
        break

if table_index is None:
    if lines and lines[-1].strip() != "":
        lines.append("")
    lines.append(table)
    lines.append(trust_line)
    changed = True
else:
    section_end = len(lines)
    for idx in range(table_index + 1, len(lines)):
        if is_header(lines[idx]):
            section_end = idx
            break

    trust_index = None
    for idx in range(table_index + 1, section_end):
        if re.match(r'^\s*trust_level\s*=', lines[idx]):
            trust_index = idx
            break

    if trust_index is None:
        lines.insert(table_index + 1, trust_line)
        changed = True
    elif not re.match(r'^\s*trust_level\s*=\s*"trusted"\s*(#.*)?$', lines[trust_index]):
        indent = re.match(r'^(\s*)', lines[trust_index]).group(1)
        lines[trust_index] = f'{indent}{trust_line}'
        changed = True

if not changed:
    raise SystemExit(0)

content = "\n".join(lines)
if content != "":
    content += "\n"

try:
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config_path.write_text(content, encoding="utf-8")
except Exception:
    raise SystemExit(0)
PY
}

ensure_current_project_trusted_in_config() {
  local cwd_logical="${PWD:-}"
  if [[ -z "$cwd_logical" ]]; then
    return 0
  fi

  ensure_project_path_trusted_in_config "$cwd_logical"

  local cwd_physical=""
  cwd_physical="$(pwd -P 2>/dev/null || true)"
  if [[ -n "$cwd_physical" && "$cwd_physical" != "$cwd_logical" ]]; then
    ensure_project_path_trusted_in_config "$cwd_physical"
  fi
}

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
  local use_cmd_prefix=0
  local -a cmd_prefix=()
  local -a cmd_line=("$CODEX_REAL_BIN")
  tmp_output="$(mktemp)"
  if start_codex_ipv4_proxy; then
    use_cmd_prefix=1
    cmd_line+=(
      -c "network.proxy_url=\"$CODEX_IPV4_PROXY_URL\""
      -c "network.allow_upstream_proxy=true"
    )
    cmd_prefix=(
      env
      HTTPS_PROXY="$CODEX_IPV4_PROXY_URL" https_proxy="$CODEX_IPV4_PROXY_URL"
      HTTP_PROXY="$CODEX_IPV4_PROXY_URL" http_proxy="$CODEX_IPV4_PROXY_URL"
      ALL_PROXY="$CODEX_IPV4_PROXY_URL" all_proxy="$CODEX_IPV4_PROXY_URL"
    )
  fi
  cmd_line+=("$@")
  local -a exec_cmd=("${cmd_line[@]}")
  if (( use_cmd_prefix )); then
    exec_cmd=("${cmd_prefix[@]}" "${exec_cmd[@]}")
  fi
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
    if (( CODEX_SSH_INTERACTIVE )) && [[ "${CODEX_FORCE_PTY:-0}" != "1" ]]; then
      # Interactive SSH is more reliable with a direct TTY handoff than nested PTY capture.
      # This favors a clean full-screen Codex UI over wrapper-side output capture on SSH runs.
      "${exec_cmd[@]}"
      status=$?
    elif [[ "$CODEX_NO_PTY" == "1" ]]; then
      # Preserve interactive TTY behavior when PTY capture is explicitly disabled.
      "${exec_cmd[@]}"
      status=$?
    elif [[ "${CODEX_FORCE_PTY:-0}" != "1" && -f "$pty_auto_disable_file" ]]; then
      # Auto-detected incompatible PTY host; run direct unless explicitly overridden.
      "${exec_cmd[@]}"
      status=$?
    else
      if [[ -z "${PROMPT_TOOLKIT_NO_CPR:-}" ]]; then
        export PROMPT_TOOLKIT_NO_CPR=1
        prompt_toolkit_no_cpr_added=1
      fi
      if [[ "$CODEX_NO_SCRIPT" != "1" ]] && command -v script >/dev/null 2>&1; then
        # Use script to keep a PTY and capture output to a typescript file while streaming to the real TTY.
        local cmd_str
        cmd_str="$(printf '%q ' "${exec_cmd[@]}")"
        detect_script_flags
        if (( SCRIPT_SUPPORTS_C )); then
          script $SCRIPT_FLAGS "$tmp_output" -c "$cmd_str"
        else
          script $SCRIPT_FLAGS "$tmp_output" "${exec_cmd[@]}"
        fi
        status=$?
      elif command -v python3 >/dev/null 2>&1; then
        # Fallback PTY using Python's pty module when script is unavailable.
        local -a pty_cmd=(python3 - "$tmp_output" "${cmd_line[@]}")
        if (( use_cmd_prefix )); then
          pty_cmd=("${cmd_prefix[@]}" "${pty_cmd[@]}")
        fi
        status=0
        "${pty_cmd[@]}" <<'PY'
import fcntl
import os
import pty
import signal
import sys
import termios
log_path = sys.argv[1]
cmd = sys.argv[2:]

def copy_winsize(from_fd, to_fd):
    try:
        winsize = fcntl.ioctl(from_fd, termios.TIOCGWINSZ, b"\0" * 8)
    except OSError:
        return
    try:
        fcntl.ioctl(to_fd, termios.TIOCSWINSZ, winsize)
    except OSError:
        pass

stdout_fd = sys.stdout.fileno()
winsize_source_fd = stdout_fd if os.isatty(stdout_fd) else None
opened_tty_fd = None
if winsize_source_fd is None:
    try:
        opened_tty_fd = os.open("/dev/tty", os.O_RDONLY)
        winsize_source_fd = opened_tty_fd
    except OSError:
        winsize_source_fd = None
with open(log_path, "wb") as log:
    pid, fd = pty.fork()
    if pid == 0:
        os.execvp(cmd[0], cmd)
    if winsize_source_fd is not None:
        copy_winsize(winsize_source_fd, fd)
    previous_winch_handler = signal.getsignal(signal.SIGWINCH)
    if winsize_source_fd is not None:
        def forward_winch(_signum, _frame):
            copy_winsize(winsize_source_fd, fd)
        signal.signal(signal.SIGWINCH, forward_winch)
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
    finally:
        try:
            signal.signal(signal.SIGWINCH, previous_winch_handler)
        except Exception:
            pass
        if opened_tty_fd is not None:
            try:
                os.close(opened_tty_fd)
            except OSError:
                pass
    _, status = os.waitpid(pid, 0)
    sys.exit(os.WEXITSTATUS(status))
PY
        status=$?
      else
        # Last-resort: run directly to preserve TTY; no tee (token usage may be skipped).
        "${exec_cmd[@]}"
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
        "${exec_cmd[@]}"
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
        "${exec_cmd[@]}" 2>&1 | tee "$tmp_output"
        status=${PIPESTATUS[0]}
      fi
    else
      "${exec_cmd[@]}" 2>&1 | tee "$tmp_output"
      status=${PIPESTATUS[0]}
    fi
  fi
  stop_codex_ipv4_proxy || true
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

codex_args_explicit_model() {
  local arg=""
  local expect_model_value=0
  local model_value=""
  for arg in "$@"; do
    if (( expect_model_value )); then
      model_value="$arg"
      expect_model_value=0
      continue
    fi
    case "$arg" in
      --model)
        expect_model_value=1
        ;;
      --model=*)
        model_value="${arg#--model=}"
        ;;
      --)
        break
        ;;
    esac
  done
  if [[ -n "$model_value" ]]; then
    printf '%s\n' "$model_value"
    return 0
  fi
  return 1
}

codex_args_explicit_profile() {
  local arg=""
  local expect_profile_value=0
  local profile_value=""
  for arg in "$@"; do
    if (( expect_profile_value )); then
      profile_value="$arg"
      expect_profile_value=0
      continue
    fi
    case "$arg" in
      --profile)
        expect_profile_value=1
        ;;
      --profile=*)
        profile_value="${arg#--profile=}"
        ;;
      --)
        break
        ;;
    esac
  done
  if [[ -n "$profile_value" ]]; then
    printf '%s\n' "$profile_value"
    return 0
  fi
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
injected_model_name=""
if (( ! user_selected_profile_or_model )) && [[ -n "$lane_selector_profile" ]]; then
  set -- --profile "$lane_selector_profile" "$@"
elif (( ! user_selected_profile_or_model )) && [[ -n "$lane_selector_model" ]]; then
  set -- --model "$lane_selector_model" "$@"
  injected_model=1
  injected_model_name="$lane_selector_model"
elif (( ! user_selected_profile_or_model )) && [[ -n "$CODEX_HOST_MODEL" ]]; then
  set -- --model "$CODEX_HOST_MODEL" "$@"
  injected_model=1
  injected_model_name="$CODEX_HOST_MODEL"
  if [[ -z "$CODEX_EFFECTIVE_LANE_SELECTOR" ]]; then
    CODEX_EFFECTIVE_LANE_SELECTOR="model:${CODEX_HOST_MODEL}"
  fi
fi

if (( ! user_selected_profile_or_model )) && (( injected_model )) && [[ -n "$CODEX_HOST_REASONING_EFFORT" ]]; then
  set -- --config "model_reasoning_effort=${CODEX_HOST_REASONING_EFFORT}" "$@"
fi

effective_model_name=""
effective_profile_name=""
if explicit_model_name="$(codex_args_explicit_model "$@")"; then
  effective_model_name="$explicit_model_name"
elif explicit_profile_name="$(codex_args_explicit_profile "$@")"; then
  effective_profile_name="$explicit_profile_name"
  if profile_model_name="$(config_profile_model "$explicit_profile_name")"; then
    effective_model_name="$profile_model_name"
  elif default_model_name="$(config_default_model)"; then
    effective_model_name="$default_model_name"
  fi
elif (( injected_model )) && [[ -n "$injected_model_name" ]]; then
  effective_model_name="$injected_model_name"
elif default_model_name="$(config_default_model)"; then
  effective_model_name="$default_model_name"
fi
if [[ -n "$effective_model_name" ]] && [[ "$(lowercase "$effective_model_name")" == *"codex-spark"* ]]; then
  # gpt-5.3-codex-spark rejects reasoning summary settings.
  if [[ "$effective_profile_name" =~ ^[A-Za-z0-9_-]+$ ]]; then
    set -- --config "profiles.${effective_profile_name}.model_reasoning_summary=none" "$@"
  fi
  set -- --config "model_reasoning_summary=none" "$@"
fi

ensure_current_project_trusted_in_config

cdx_debug_phase "total-boot" "$CDX_BOOT_START_NS"
CDX_RUN_START_NS="$(cdx_time_ms)"
CODEX_COMMAND_STARTED=1
if run_codex_command "$@"; then
  cmd_status=0
else
  cmd_status=$?
fi
push_auth_if_changed "push" || true
exit "$cmd_status"
