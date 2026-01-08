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
    public static function build(string $baseUrl, string $token): string
    {
        $baseUrl = trim($baseUrl);
        if ($baseUrl === '' || $baseUrl === 'http://' || $baseUrl === 'https://') {
            throw new \InvalidArgumentException('Seed base URL is missing.');
        }

        $token = trim($token);
        if ($token === '') {
            throw new \InvalidArgumentException('Seed token is missing.');
        }

        $postUrl = rtrim($baseUrl, '/') . '/seed/auth/' . $token;

        return <<<BASH
#!/usr/bin/env bash
set -euo pipefail

if [[ -z "\${HOME:-}" ]]; then
  echo "HOME is not set; cannot locate auth.json." >&2
  exit 1
fi

AUTH_PATH="\${HOME}/.codex/auth.json"
if [[ ! -f "\${AUTH_PATH}" ]]; then
  echo "auth.json not found at \${AUTH_PATH}" >&2
  exit 1
fi

if command -v python3 >/dev/null 2>&1; then
  python3 - "\${AUTH_PATH}" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as fh:
    json.load(fh)
PY
else
  if ! grep -q '"last_refresh"' "\${AUTH_PATH}"; then
    echo "auth.json does not look valid (missing last_refresh)" >&2
    exit 1
  fi
fi

echo "Uploading auth.json to {$postUrl}..."
curl -fsSL -X POST "{$postUrl}" -H 'Content-Type: application/json' --data-binary @"\${AUTH_PATH}"
echo
echo "Seed complete."
BASH;
    }
}
