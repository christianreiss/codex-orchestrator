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

    public function testTemplateAddsIpv4FlagWhenForced(): void
    {
        $script = $this->buildScript(['force_ipv4' => 1]);

        $this->assertStringContainsString("CURL_FLAGS+=('-4')", $script);
    }

    public function testTemplateIncludesMuslFallbackForOldGlibc(): void
    {
        $script = $this->buildScript();

        $this->assertStringContainsString('detect_glibc_version', $script);
        $this->assertStringContainsString('unknown-linux-musl.tar.gz', $script);
        $this->assertStringContainsString('glibc_version', $script);
    }

    /**
     * @param array<string, mixed> $hostOverrides
     */
    private function buildScript(array $hostOverrides = []): string
    {
        $host = array_merge([
            'fqdn' => 'host.test',
            'force_ipv4' => 0,
        ], $hostOverrides);

        $token = [
            'api_key' => 'api-key',
            'fqdn' => 'host.test',
        ];

        return InstallerScriptBuilder::build(
            $host,
            $token,
            'https://codex.test',
            ['client_version' => '1.2.3']
        );
    }
}
