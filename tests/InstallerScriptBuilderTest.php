<?php

declare(strict_types=1);

use App\Support\InstallerScriptBuilder;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InstallerScriptBuilderTest extends TestCase
{
    public function testTemplateIncludesInstallerEnvFlag(): void
    {
        $script = $this->buildScript();

        $this->assertStringContainsString('CODEX_INSTALL_CURL_INSECURE', $script);
        $this->assertStringContainsString('curl "${CURL_FLAGS[@]+', $script);
        $this->assertStringContainsString("DEFAULT_CURL_INSECURE='0'", $script);
    }

    public function testTemplateDefaultsToInsecureWhenHostRequestsIt(): void
    {
        $script = $this->buildScript(['curl_insecure' => 1]);

        $this->assertStringContainsString("DEFAULT_CURL_INSECURE='1'", $script);
    }

    public function testTemplateIncludesMuslFallbackForOldGlibc(): void
    {
        $script = $this->buildScript();

        $this->assertStringContainsString('detect_glibc_version', $script);
        $this->assertStringContainsString('unknown-linux-musl.tar.gz', $script);
        $this->assertStringContainsString('glibc_version', $script);
    }

    public function testTemplateKeepsRequestedCodexVersionOnSsh(): void
    {
        $script = $this->buildScript([], '0.120.0');

        $this->assertStringNotContainsString('codex_ssh_regression_fallback_version()', $script);
        $this->assertStringNotContainsString('SSH safeguard: Codex ${CODEX_VERSION} is blocked for interactive SSH sessions', $script);
        $this->assertStringContainsString('echo "Target Codex: ${CODEX_VERSION}"', $script);
        $this->assertStringContainsString('rust-v${CODEX_VERSION}/${asset}', $script);
    }

    public function testTemplateRaisesLowRequestedCodexVersionToMinimumFloor(): void
    {
        $script = $this->buildScript([], '0.101.0');

        $this->assertStringContainsString("CODEX_VERSION='0.114.0'", $script);
    }

    public function testTemplateDoesNotAutoRunCdxAfterInstall(): void
    {
        $script = $this->buildScript();

        $this->assertStringNotContainsString('Launching cdx...', $script);
        $this->assertStringNotContainsString('if ! "$install_path"; then', $script);
        $this->assertStringContainsString('Next steps:', $script);
        $this->assertStringContainsString('1) Check versions: cdx --version', $script);
        $this->assertStringContainsString('2) Sync auth + start Codex: cdx', $script);
        $this->assertStringContainsString('3) Run one-shot prompt: cdx --execute \"summarize this repo\"', $script);
    }

    public function testClaudeTemplateInstallsClxAndClaudeCode(): void
    {
        $script = $this->buildScript([], '1.2.3', 'claude');

        $this->assertStringContainsString('Installing Claude Code for ${FQDN}', $script);
        $this->assertStringContainsString('/wrapper/download?engine=claude', $script);
        $this->assertStringContainsString('npm install -g @anthropic-ai/claude-code', $script);
        $this->assertStringContainsString('clx_install_path="/usr/local/bin/clx"', $script);
        $this->assertStringContainsString('1) Check versions: clx --version', $script);
        $this->assertStringContainsString('2) Sync auth + start Claude Code: clx', $script);
        $this->assertStringContainsString('3) Run one-shot prompt: clx \"summarize this repo\"', $script);
    }

    public function testCombinedTemplateInstallsBothWrappersAndCliTools(): void
    {
        $script = $this->buildScript([], '1.2.3', 'both');

        $this->assertStringContainsString('Installing Codex + Claude for ${FQDN}', $script);
        $this->assertStringContainsString('/wrapper/download?engine=codex', $script);
        $this->assertStringContainsString('/wrapper/download?engine=claude', $script);
        $this->assertStringContainsString('npm install -g @anthropic-ai/claude-code', $script);
        $this->assertStringContainsString('Target Codex: ${CODEX_VERSION}', $script);
        $this->assertStringContainsString('Target Claude Code: latest npm release', $script);
        $this->assertStringContainsString('1) Check versions: cdx --version && clx --version', $script);
        $this->assertStringContainsString('2) Sync auth + start Codex: cdx', $script);
        $this->assertStringContainsString('3) Sync auth + start Claude Code: clx', $script);
    }

    /**
     * @param array<string, mixed> $hostOverrides
     */
    private function buildScript(
        array $hostOverrides = [],
        string $clientVersion = '1.2.3',
        string $installerMode = 'codex'
    ): string
    {
        $host = array_merge([
            'fqdn' => 'host.test',
        ], $hostOverrides);

        $token = [
            'api_key' => 'api-key',
            'fqdn' => 'host.test',
            'engine' => $installerMode,
        ];

        return InstallerScriptBuilder::build(
            $host,
            $token,
            'https://codex.test',
            ['client_version' => $clientVersion]
        );
    }
}
