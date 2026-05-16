<?php

declare(strict_types=1);

namespace App\Services\Wrapper\V2;

use App\Support\Engine;
use InvalidArgumentException;

/**
 * Compact seed-auth script for wrapper v2. The host runs:
 *   curl ... /seed/v2/auth/<token> | sh
 * which uploads its local ~/.codex/auth.json (or ~/.claude/.credentials.json)
 * back to the orchestrator. ~50 lines vs the v1 builder's 166.
 */
final class SeedAuthScriptBuilderV2
{
    public static function build(string $baseUrl, string $token, string $engine = Engine::CODEX): string
    {
        $token = trim($token);
        if ($token === '') {
            throw new InvalidArgumentException('Seed token missing');
        }
        $baseUrl = rtrim($baseUrl, '/');
        if ($baseUrl === '' || $baseUrl === 'http:' || $baseUrl === 'https:') {
            throw new InvalidArgumentException('Seed base URL invalid');
        }
        $engine = Engine::isValid($engine) ? $engine : Engine::CODEX;
        $postUrl = $baseUrl . '/seed/v2/auth/' . $token;
        $authPath = $engine === Engine::CLAUDE
            ? '$HOME/.claude/.credentials.json'
            : '$HOME/.codex/auth.json';
        $label = $engine === Engine::CLAUDE ? 'Claude credentials' : 'Codex auth.json';
        $postUrlQ = self::shellQuote($postUrl);

        return <<<SH
#!/bin/sh
# Codex Orchestrator wrapper-v2 seed-auth uploader ({$engine}).
set -eu

AUTH_PATH={$authPath}
if [ ! -f "\$AUTH_PATH" ]; then
  echo "{$label} not found at \$AUTH_PATH" >&2
  exit 1
fi

echo ">> Uploading {$label} to orchestrator"
curl -fsSL -X POST \\
  -H "Content-Type: application/json" \\
  --data-binary @"\$AUTH_PATH" \\
  -o /tmp/seed-auth-response.json \\
  {$postUrlQ} || { echo "Upload failed; see /tmp/seed-auth-response.json" >&2; exit 1; }

echo "Done. Server response:"
cat /tmp/seed-auth-response.json
echo
SH;
    }

    private static function shellQuote(string $value): string
    {
        return "'" . str_replace("'", "'\\''", $value) . "'";
    }
}
