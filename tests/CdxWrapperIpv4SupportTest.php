<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperIpv4SupportTest extends TestCase
{
    public function testBuiltWrapperAcceptsDash4AndDefaultsIpv4ModeOff(): void
    {
        $wrapperSource = $this->readFile(__DIR__ . '/../bin/cdx');

        self::assertStringContainsString('CODEX_FORCE_IPV4="0"', $wrapperSource);
        self::assertStringContainsString('if [[ "$arg" == "-4" ]]; then', $wrapperSource);
        self::assertStringContainsString('CODEX_FORCE_IPV4=1', $wrapperSource);
    }

    public function testBuiltWrapperRunsCodexChildThroughLocalIpv4ProxyWhenEnabled(): void
    {
        $wrapperSource = $this->readFile(__DIR__ . '/../bin/cdx');

        self::assertStringContainsString('start_codex_ipv4_proxy() {', $wrapperSource);
        self::assertStringContainsString('CODEX_IPV4_PROXY_URL="http://127.0.0.1:${port}"', $wrapperSource);
        self::assertStringContainsString('-c "network.proxy_url=\"$CODEX_IPV4_PROXY_URL\""', $wrapperSource);
        self::assertStringContainsString('-c "network.allow_upstream_proxy=true"', $wrapperSource);
        self::assertStringContainsString('HTTPS_PROXY="$CODEX_IPV4_PROXY_URL" https_proxy="$CODEX_IPV4_PROXY_URL"', $wrapperSource);
        self::assertStringContainsString('HTTP_PROXY="$CODEX_IPV4_PROXY_URL" http_proxy="$CODEX_IPV4_PROXY_URL"', $wrapperSource);
        self::assertStringContainsString('ALL_PROXY="$CODEX_IPV4_PROXY_URL" all_proxy="$CODEX_IPV4_PROXY_URL"', $wrapperSource);
    }

    public function testBuiltWrapperStopsIpv4ProxyOnCleanupAndAfterCodexRun(): void
    {
        $wrapperSource = $this->readFile(__DIR__ . '/../bin/cdx');

        self::assertStringContainsString('stop_codex_ipv4_proxy() {', $wrapperSource);
        self::assertStringContainsString('kill "$proxy_pid"', $wrapperSource);
        self::assertStringContainsString('rm -rf "$CODEX_IPV4_PROXY_DIR"', $wrapperSource);
        self::assertGreaterThanOrEqual(
            2,
            substr_count($wrapperSource, 'stop_codex_ipv4_proxy || true'),
            'Expected wrapper cleanup to stop the IPv4 proxy both on EXIT and after Codex finishes.'
        );
    }

    public function testIpv4HelperFragmentsCoverPythonAndCurlNetworkPaths(): void
    {
        $httpHelper = $this->readFile(__DIR__ . '/../bin/cdx.d/00-prolog/10-python-http.sh');
        $proxyHelper = $this->readFile(__DIR__ . '/../bin/cdx.d/00-prolog/11-python-ipv4-proxy.sh');
        $authSync = $this->readFile(__DIR__ . '/../bin/cdx.d/02-auth-10-sync.sh');
        $promptSync = $this->readFile(__DIR__ . '/../bin/cdx.d/03-sync-10-prompts.sh');
        $agentsSync = $this->readFile(__DIR__ . '/../bin/cdx.d/03-sync-30-agents.sh');
        $configSync = $this->readFile(__DIR__ . '/../bin/cdx.d/03-sync-40-config/10-config-sync-python.sh');
        $startupBundle = $this->readFile(__DIR__ . '/../bin/cdx.d/03-sync-40-config/20-startup-bundle-python.sh');
        $usageSync = $this->readFile(__DIR__ . '/../bin/cdx.d/03-sync-50-usage.sh');
        $cronSync = $this->readFile(__DIR__ . '/../bin/cdx.d/04-update-50-cron.sh');
        $updateScript = $this->readFile(__DIR__ . '/../bin/cdx.d/04-update.sh');
        $summaryScript = $this->readFile(__DIR__ . '/../bin/cdx.d/05-main-20-summary.sh');

        self::assertStringContainsString('def cdx_enable_force_ipv4():', $httpHelper);
        self::assertStringContainsString('socket.AF_INET', $httpHelper);
        self::assertStringContainsString('ThreadedTcpServer(("127.0.0.1", 0), ProxyHandler)', $proxyHelper);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $authSync);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $promptSync);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $agentsSync);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $configSync);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $startupBundle);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $usageSync);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $cronSync);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $updateScript);
        self::assertStringContainsString('CODEX_FORCE_IPV4="${CODEX_FORCE_IPV4:-0}"', $summaryScript);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $authSync);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $promptSync);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $agentsSync);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $configSync);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $startupBundle);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $usageSync);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $cronSync);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $updateScript);
        self::assertStringContainsString('cdx_enable_force_ipv4()', $summaryScript);
        self::assertStringContainsString('curl_args+=("-4")', $updateScript);
    }

    private function readFile(string $path): string
    {
        $source = @file_get_contents($path);
        self::assertIsString($source, sprintf('Expected to be able to read %s', $path));

        return $source;
    }
}
