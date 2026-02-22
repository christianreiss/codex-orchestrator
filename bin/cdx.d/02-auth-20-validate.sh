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
  local max_age_seconds="${2:-$MAX_LOCAL_AUTH_AGE_SECONDS}"
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
try:
    dt = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
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
  if ! command -v python3 >/dev/null 2>&1; then
    return 1
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

last_refresh = data.get("last_refresh")
auths = data.get("auths")
tokens = data.get("tokens")
openai_key = data.get("OPENAI_API_KEY")

if not isinstance(last_refresh, str) or not last_refresh.strip():
    sys.exit(1)

has_auths = isinstance(auths, dict) and bool(auths)
fallback_token = None
if isinstance(tokens, dict):
    access_token = tokens.get("access_token")
    if isinstance(access_token, str) and access_token.strip():
        fallback_token = access_token.strip()
if isinstance(openai_key, str) and openai_key.strip():
    fallback_token = openai_key.strip()

if not has_auths:
    if fallback_token is None:
        sys.exit(1)
    sys.exit(0)

for target, entry in auths.items():
    if not isinstance(target, str) or not target.strip():
        sys.exit(1)
    if not isinstance(entry, dict):
        sys.exit(1)
    token = entry.get("token")
    if not isinstance(token, str) or not token.strip():
        sys.exit(1)

sys.exit(0)
PY
}

