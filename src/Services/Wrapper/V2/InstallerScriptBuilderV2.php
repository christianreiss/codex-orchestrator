<?php

declare(strict_types=1);

namespace App\Services\Wrapper\V2;

use App\Support\Engine;
use InvalidArgumentException;

/**
 * Compact installer script for wrapper v2:
 *   1. Optionally installs the upstream engine CLI (codex / claude).
 *   2. Writes the bootstrap shim to ~/.local/bin/<name>.
 *   3. Runs the shim once so the host can `cdx run` / `clx run` immediately.
 *
 * Total size: ~150 lines (the v1 builder was 597).
 */
final class InstallerScriptBuilderV2
{
    /**
     * @param array<string,mixed> $host
     * @param array<string,mixed> $tokenRow
     */
    public static function build(array $host, array $tokenRow, string $baseUrl, string $engine): string
    {
        $engine = Engine::isValid($engine) ? $engine : Engine::CODEX;
        $name = Engine::WRAPPER_NAME[$engine];
        $cliName = Engine::CLI_BINARY[$engine];

        $apiKey = (string) ($tokenRow['api_key'] ?? $host['api_key'] ?? '');
        if ($apiKey === '') {
            throw new InvalidArgumentException('Installer host API key missing');
        }
        $fqdn = (string) ($host['fqdn'] ?? '');
        if ($fqdn === '') {
            throw new InvalidArgumentException('Installer host FQDN missing');
        }
        $apiKeyQ = self::shellQuote($apiKey);
        $baseUrlQ = self::shellQuote(rtrim($baseUrl, '/'));
        $fqdnQ = self::shellQuote($fqdn);
        $shim = BootstrapShimBuilder::build($engine, $baseUrl, $apiKey);
        $shimQ = self::heredocEscape($shim);

        $cliHint = $engine === Engine::CLAUDE
            ? "command -v $cliName >/dev/null 2>&1 || echo \">> Install Claude CLI manually (e.g. npm install -g @anthropic-ai/claude-code) and re-run.\""
            : "command -v $cliName >/dev/null 2>&1 || echo \">> Install Codex CLI manually (e.g. via the upstream installer) and re-run.\"";

        return <<<SH
#!/bin/sh
# Codex Orchestrator wrapper-v2 installer for {$name}.
# Generated for host {$fqdnQ}.
set -eu

BASE_URL={$baseUrlQ}
HOST_API_KEY={$apiKeyQ}
BIN_DIR=\${BIN_DIR:-\$HOME/.local/bin}
mkdir -p "\$BIN_DIR"
echo ">> Installing the {$name} wrapper into \$BIN_DIR"

# 1. Write the bootstrap shim.
cat > "\$BIN_DIR/{$name}" <<'__CODEX_WRAPPER_SHIM__'
{$shimQ}
__CODEX_WRAPPER_SHIM__
chmod +x "\$BIN_DIR/{$name}"

# 2. Friendly engine CLI hint (the wrapper invokes this binary).
{$cliHint}

# 3. First run — pulls the signed config + the platform-specific binary.
echo ">> First sync"
"\$BIN_DIR/{$name}" status || true

echo
echo "Done. Try: {$name} run    (or {$name} doctor for a self-check)."
SH;
    }

    private static function shellQuote(string $value): string
    {
        return "'" . str_replace("'", "'\\''", $value) . "'";
    }

    /**
     * Escape body so it can be safely embedded as a quoted heredoc.
     * Since the heredoc delimiter is single-quoted ('__CODEX_WRAPPER_SHIM__'),
     * the body is passed through verbatim — but we still strip any line that
     * happens to equal the delimiter literally, which would terminate the
     * heredoc early.
     */
    private static function heredocEscape(string $body): string
    {
        return preg_replace('/^__CODEX_WRAPPER_SHIM__$/m', '__CODEX_WRAPPER_SHIM__#', $body) ?? $body;
    }
}
