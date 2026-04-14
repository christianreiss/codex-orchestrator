<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperIpv4SupportTest extends TestCase
{
    public function testIpv4ProxyFragmentIsWiredIntoWrapper(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/05-main-48-ipv4.sh');
        self::assertIsString($fragment);

        // The Claude wrapper reuses the Codex IPv4 helper functions with
        // engine-prefixed env vars.
        self::assertStringContainsString('start_claude_ipv4_proxy', $fragment);
        self::assertStringContainsString('stop_claude_ipv4_proxy', $fragment);
    }

    public function testRunFragmentWiresIpv4ProxyEnvIntoClaudeExec(): void
    {
        $run = file_get_contents(__DIR__ . '/../bin/clx.d/05-main-50-run.sh');
        self::assertIsString($run);

        self::assertStringContainsString('start_claude_ipv4_proxy', $run);
        self::assertStringContainsString('HTTPS_PROXY="$CLAUDE_IPV4_PROXY_URL"', $run);
        self::assertStringContainsString('HTTP_PROXY="$CLAUDE_IPV4_PROXY_URL"', $run);
    }
}
