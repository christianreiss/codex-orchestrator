<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperIpv4ProxyTest extends TestCase
{
    public function testWrapperStartsScopedIpv4ProxyForCodexLaunches(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('CODEX_PY_IPV4_PROXY_UTIL', $wrapperSource);
        self::assertStringContainsString('start_codex_ipv4_proxy()', $wrapperSource);
        self::assertStringContainsString('CODEX_IPV4_PROXY_URL="http://127.0.0.1:${port}"', $wrapperSource);
        self::assertStringContainsString('network.proxy_url=\\"$CODEX_IPV4_PROXY_URL\\"', $wrapperSource);
        self::assertStringContainsString('network.allow_upstream_proxy=true', $wrapperSource);
    }

    public function testWrapperScopesProxyEnvToCodexChildAndCleansItUp(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('HTTPS_PROXY="$CODEX_IPV4_PROXY_URL"', $wrapperSource);
        self::assertStringContainsString('ALL_PROXY="$CODEX_IPV4_PROXY_URL"', $wrapperSource);
        self::assertStringContainsString('stop_codex_ipv4_proxy()', $wrapperSource);
        self::assertStringContainsString('stop_codex_ipv4_proxy || true', $wrapperSource);
    }

    public function testWrapperGuardsOptionalProxyArraysOnLegacyBash(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('local use_cmd_prefix=0', $wrapperSource);
        self::assertStringContainsString('local -a cmd_line=("$CODEX_REAL_BIN")', $wrapperSource);
        self::assertStringContainsString('local -a exec_cmd=("${cmd_line[@]}")', $wrapperSource);
        self::assertStringNotContainsString('${proxy_args[@]}', $wrapperSource);
        self::assertMatchesRegularExpression(
            '/local -a exec_cmd=\\("\\$\\{cmd_line\\[@\\]\\}"\\)\\s+if \\(\\( use_cmd_prefix \\)\\); then\\s+exec_cmd=\\("\\$\\{cmd_prefix\\[@\\]\\}" "\\$\\{exec_cmd\\[@\\]\\}"\\)/',
            $wrapperSource,
            'Legacy macOS Bash 3.2 must not expand empty proxy/prefix arrays under `set -u`.'
        );
    }
}
