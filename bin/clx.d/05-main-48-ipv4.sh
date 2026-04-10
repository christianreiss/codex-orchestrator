# ── CLX IPv4 Proxy ────────────────────────────────────────────
# Local proxy for forcing Claude Code traffic through IPv4.

CLAUDE_IPV4_PROXY_PID=""
CLAUDE_IPV4_PROXY_DIR=""
CLAUDE_IPV4_PROXY_URL=""

stop_claude_ipv4_proxy() {
  local proxy_pid="${CLAUDE_IPV4_PROXY_PID:-}"
  if [[ -n "$proxy_pid" ]]; then
    kill "$proxy_pid" >/dev/null 2>&1 || true
    wait "$proxy_pid" >/dev/null 2>&1 || true
  fi
  if [[ -n "${CLAUDE_IPV4_PROXY_DIR:-}" ]] && [[ -d "$CLAUDE_IPV4_PROXY_DIR" ]]; then
    rm -rf "$CLAUDE_IPV4_PROXY_DIR" >/dev/null 2>&1 || true
  fi
  CLAUDE_IPV4_PROXY_PID=""
  CLAUDE_IPV4_PROXY_DIR=""
  CLAUDE_IPV4_PROXY_URL=""
}

start_claude_ipv4_proxy() {
  if [[ "${CLAUDE_FORCE_IPV4:-0}" != "1" ]]; then
    return 1
  fi
  if [[ -n "${CLAUDE_IPV4_PROXY_URL:-}" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    log_warn "python3 is unavailable; Claude Code traffic cannot be forced through the local IPv4 proxy."
    return 1
  fi

  local state_dir port_file port=""
  state_dir="$(mktemp -d "${TMPDIR:-/tmp}/clx-ipv4-proxy.XXXXXX")"
  port_file="$state_dir/port"
  CLAUDE_IPV4_PROXY_DIR="$state_dir"

  CLAUDE_IPV4_PROXY_DIR="$state_dir" python3 -u - <<'PY' >/dev/null 2>&1 &
import os
namespace = {}
exec(os.environ["CLAUDE_PY_IPV4_PROXY_UTIL"], namespace)
raise SystemExit(namespace["main"]())
PY
  CLAUDE_IPV4_PROXY_PID="$!"

  local _i=0
  for ((_i = 0; _i < 50; _i++)); do
    if [[ -f "$port_file" ]]; then
      port="$(tr -d '[:space:]' <"$port_file")"
      break
    fi
    if ! kill -0 "$CLAUDE_IPV4_PROXY_PID" >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done

  if [[ -z "$port" ]] || ! [[ "$port" =~ ^[0-9]+$ ]]; then
    log_warn "Failed to start the local IPv4 proxy; continuing without forcing Claude Code traffic to IPv4."
    stop_claude_ipv4_proxy
    return 1
  fi

  CLAUDE_IPV4_PROXY_URL="http://127.0.0.1:${port}"
  return 0
}
