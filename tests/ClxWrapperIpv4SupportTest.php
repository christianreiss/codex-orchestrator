<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperIpv4SupportTest extends TestCase
{
    public function testIpv4ProxyFragmentIsWiredIntoWrapper(): void
    {
        // The Go wrapper reuses an ipv4 proxy package (wrappers/clx/internal/ipv4/proxy.go)
        // that forces all outbound traffic to IPv4 — equivalent to the bash
        // start_claude_ipv4_proxy / stop_claude_ipv4_proxy helper functions.
        $proxySource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/ipv4/proxy.go');
        self::assertIsString($proxySource);

        // Start() is the Go equivalent of start_claude_ipv4_proxy
        self::assertStringContainsString('func Start(', $proxySource);
        // Stop() is the Go equivalent of stop_claude_ipv4_proxy
        self::assertStringContainsString('func (p *Proxy) Stop()', $proxySource);

        // The proxy forces tcp4 on all outbound connections
        self::assertStringContainsString('"tcp4"', $proxySource);

        // PreExec wires the IPv4 proxy into the clx launch sequence
        $preexecSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/preexec.go');
        self::assertIsString($preexecSource);
        self::assertStringContainsString('ipv4.Start(', $preexecSource);
    }

    public function testRunFragmentWiresIpv4ProxyEnvIntoClaudeExec(): void
    {
        // PreExec sets HTTP_PROXY / HTTPS_PROXY to the proxy URL when
        // CLAUDE_FORCE_IPV4=1 — equivalent to the bash run fragment injecting
        // CLAUDE_IPV4_PROXY_URL into the exec environment.
        $preexecSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/preexec.go');
        self::assertIsString($preexecSource);

        self::assertStringContainsString('ipv4.Start(', $preexecSource);
        self::assertStringContainsString('HTTPS_PROXY', $preexecSource);
        self::assertStringContainsString('HTTP_PROXY', $preexecSource);

        // The env vars are set to the proxy URL (p.URL)
        self::assertStringContainsString('p.URL', $preexecSource);

        // The feature is activated by CLAUDE_FORCE_IPV4=1 or CODEX_FORCE_IPV4=1
        self::assertStringContainsString('CLAUDE_FORCE_IPV4', $preexecSource);
    }
}
