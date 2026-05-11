# ── Claude Auth Validation ────────────────────────────────────
# Validates the shape of a locally-cached Claude credentials JSON.
# Mirrors cdx's 02-auth-20-validate.sh surface so operators can rely on the
# same helpers (get_auth_last_refresh, is_last_refresh_recent, validate_auth_json_file)
# regardless of engine.
#
# Accepted Claude credential shapes:
#   1. {"api_key": "sk-ant-...", ...}                     (plain API key)
#   2. {"anthropic_api_key": "sk-ant-...", ...}           (alias)
#   3. {"auths": {"api.anthropic.com": {"token": "..."}}} (Codex-compatible)
#   4. {"claudeAiOauth": {"accessToken": "sk-ant-oat..."}} (Claude Code login)
# A valid file MUST contain a usable token via one of these shapes.
# The optional `last_refresh` field enables freshness checks.

get_auth_last_refresh() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 0
  fi
  python3 - "$path" <<'PY'
import json, sys, pathlib
path = pathlib.Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    sys.exit(0)
if isinstance(data, dict):
    lr = data.get("last_refresh")
    if isinstance(lr, str):
        print(lr, end="")
PY
}

is_last_refresh_recent() {
  local last_refresh="$1"
  local max_age_seconds="${2:-${MAX_LOCAL_AUTH_AGE_SECONDS:-86400}}"
  if [[ -z "$last_refresh" ]]; then
    return 1
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
  fi
  python3 - "$last_refresh" "$max_age_seconds" <<'PY'
import sys, datetime
from datetime import timezone

value = sys.argv[1]
max_age_seconds = int(sys.argv[2])
max_future_skew = 300

def parse_iso8601(raw):
    normalized = (raw or "").strip()
    if not normalized:
        raise ValueError("missing timestamp")
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+0000"
    elif len(normalized) >= 6 and normalized[-6] in ("+", "-") and normalized[-3] == ":":
        normalized = normalized[:-3] + normalized[-2:]

    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z"):
        try:
            return datetime.datetime.strptime(normalized, fmt)
        except Exception:
            continue
    raise ValueError("invalid timestamp")

try:
    dt = parse_iso8601(value)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    now = datetime.datetime.now(timezone.utc)
    delta = now - dt
except Exception:  # noqa: BLE001
    sys.exit(1)

if delta.total_seconds() < -max_future_skew:
    sys.exit(1)
if delta.total_seconds() <= max_age_seconds:
    sys.exit(0)
sys.exit(1)
PY
}

validate_auth_json_file() {
  local path="$1"
  if [[ ! -f "$path" ]]; then
    return 1
  fi
  # Fallback: a cheap jq validation so this helper works even when python3 is absent.
  if ! command -v python3 >/dev/null 2>&1; then
    if ! command -v jq >/dev/null 2>&1; then
      return 1
    fi
    local probe
    probe="$(jq -r '(.api_key // .anthropic_api_key // .ANTHROPIC_API_KEY // .auths["api.anthropic.com"].token // .claudeAiOauth.accessToken // empty)' "$path" 2>/dev/null || true)"
    [[ -n "$probe" ]] && return 0 || return 1
  fi

  python3 - "$path" <<'PY'
import json, sys, pathlib

path = pathlib.Path(sys.argv[1])
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    sys.exit(1)

if not isinstance(data, dict):
    sys.exit(1)

api_key = data.get("api_key")
alt_key = data.get("anthropic_api_key")
auths = data.get("auths")
oauth = data.get("claudeAiOauth")

def _valid_token(v):
    return isinstance(v, str) and len(v.strip()) >= 8

env_key = data.get("ANTHROPIC_API_KEY")
if _valid_token(api_key) or _valid_token(alt_key) or _valid_token(env_key):
    sys.exit(0)

if isinstance(auths, dict):
    entry = auths.get("api.anthropic.com")
    if isinstance(entry, dict):
        token = entry.get("token")
        if _valid_token(token):
            sys.exit(0)

if isinstance(oauth, dict) and _valid_token(oauth.get("accessToken")):
    sys.exit(0)

sys.exit(1)
PY
}

clx_auth_extract_api_key() {
  local path="$1"
  if [[ ! -f "$path" ]] || ! command -v jq >/dev/null 2>&1; then
    return 1
  fi
  jq -r '
    .api_key
    // .anthropic_api_key
    // .ANTHROPIC_API_KEY
    // .auths["api.anthropic.com"].token
    // .claudeAiOauth.accessToken
    // empty
  ' "$path" 2>/dev/null | head -n1
}
