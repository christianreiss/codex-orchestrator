<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Support;

final class SeedAuthScriptBuilder
{
    public static function build(string $baseUrl, string $token, string $engine = Engine::CODEX): string
    {
        $baseUrl = trim($baseUrl);
        if ($baseUrl === '' || $baseUrl === 'http://' || $baseUrl === 'https://') {
            throw new \InvalidArgumentException('Seed base URL is missing.');
        }

        $token = trim($token);
        if ($token === '') {
            throw new \InvalidArgumentException('Seed token is missing.');
        }

        $engine = Engine::isValid($engine) ? $engine : Engine::CODEX;
        $postUrl = rtrim($baseUrl, '/') . '/seed/auth/' . $token;

        return <<<BASH
#!/usr/bin/env bash
set -euo pipefail
ENGINE="{$engine}"

if [[ -z "\${HOME:-}" ]]; then
  echo "HOME is not set; cannot locate credentials." >&2
  exit 1
fi

case "\${ENGINE}" in
  claude)
    AUTH_PATH="\${HOME}/.claude/.credentials.json"
    AUTH_LABEL="Claude credentials"
    ;;
  *)
    AUTH_PATH="\${HOME}/.codex/auth.json"
    AUTH_LABEL="Codex auth.json"
    ;;
esac

if [[ ! -f "\${AUTH_PATH}" ]]; then
  echo "\${AUTH_LABEL} not found at \${AUTH_PATH}" >&2
  exit 1
fi

if ! command -v mktemp >/dev/null 2>&1; then
  echo "mktemp is required to prepare the upload." >&2
  exit 1
fi

UPLOAD_PATH="\$(mktemp)"
RESPONSE_PATH="\$(mktemp)"
cleanup() {
  rm -f "\${UPLOAD_PATH:-}" "\${RESPONSE_PATH:-}"
}
trap cleanup EXIT

if command -v python3 >/dev/null 2>&1; then
  python3 - "\${ENGINE}" "\${AUTH_PATH}" "\${UPLOAD_PATH}" <<'PY'
import datetime
import json
import sys

engine = sys.argv[1]
path = sys.argv[2]
out_path = sys.argv[3]
with open(path, 'r', encoding='utf-8') as fh:
    payload = json.load(fh)

if not isinstance(payload, dict):
    raise SystemExit("credential payload must contain a JSON object")

last_refresh = payload.get("last_refresh")
if not isinstance(last_refresh, str) or not last_refresh.strip():
    payload["last_refresh"] = (
        datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )

auths = payload.get("auths")
tokens = payload.get("tokens")
has_auths = isinstance(auths, dict) and bool(auths)
if engine == "claude":
    has_api_key = any(
        isinstance(payload.get(key), str) and bool(payload.get(key).strip())
        for key in ("api_key", "anthropic_api_key", "ANTHROPIC_API_KEY")
    )
    if not (has_auths or has_api_key):
        raise SystemExit("Claude credentials must contain auths, api_key, anthropic_api_key, or ANTHROPIC_API_KEY")
else:
    has_access_token = (
        isinstance(tokens, dict)
        and isinstance(tokens.get("access_token"), str)
        and bool(tokens.get("access_token").strip())
    )
    has_openai_api_key = (
        isinstance(payload.get("OPENAI_API_KEY"), str)
        and bool(payload.get("OPENAI_API_KEY").strip())
    )
    if not (has_auths or has_access_token or has_openai_api_key):
        raise SystemExit("Codex auth.json must contain auths, tokens.access_token, or OPENAI_API_KEY")

with open(out_path, 'w', encoding='utf-8') as out:
    json.dump(payload, out, ensure_ascii=False, separators=(',', ':'))
PY
else
  if ! grep -q '"last_refresh"' "\${AUTH_PATH}"; then
    echo "\${AUTH_LABEL} is missing last_refresh; install python3 so the seed script can normalize plain credential files." >&2
    exit 1
  fi
  if [[ "\${ENGINE}" == "claude" ]]; then
    if ! grep -Eq '"auths"|"api_key"|"anthropic_api_key"|"ANTHROPIC_API_KEY"' "\${AUTH_PATH}"; then
      echo "\${AUTH_LABEL} does not contain auths, api_key, anthropic_api_key, or ANTHROPIC_API_KEY." >&2
      exit 1
    fi
  else
    if ! grep -Eq '"auths"|"access_token"|"OPENAI_API_KEY"' "\${AUTH_PATH}"; then
      echo "\${AUTH_LABEL} does not contain auths, access_token, or OPENAI_API_KEY." >&2
      exit 1
    fi
  fi
  cp "\${AUTH_PATH}" "\${UPLOAD_PATH}"
fi

echo "Uploading \${AUTH_LABEL} to {$postUrl}..."
set +e
HTTP_CODE="\$(curl -sS -w '%{http_code}' -o "\${RESPONSE_PATH}" -X POST "{$postUrl}" -H 'Content-Type: application/json' --data-binary @"\${UPLOAD_PATH}")"
CURL_RC=\$?
set -e
if [[ \${CURL_RC} -ne 0 ]]; then
  echo "Upload failed (curl exit \${CURL_RC})." >&2
  if [[ -s "\${RESPONSE_PATH}" ]]; then
    cat "\${RESPONSE_PATH}" >&2
    echo >&2
  fi
  exit "\${CURL_RC}"
fi
if [[ ! "\${HTTP_CODE}" =~ ^2[0-9][0-9]\$ ]]; then
  echo "Upload failed (HTTP \${HTTP_CODE})." >&2
  if [[ -s "\${RESPONSE_PATH}" ]]; then
    cat "\${RESPONSE_PATH}" >&2
    echo >&2
  fi
  exit 1
fi
echo "Seed complete."
BASH;
    }
}
