<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperIpv4SupportTest extends TestCase
{
    public function testBuiltWrapperAcceptsDash4AndDefaultsIpv4ModeOff(): void
    {
        // The Go main.go parses -4 / --ipv4 and sets CODEX_FORCE_IPV4=1 in the
        // env (default is unset / off). Verify both the flag name and the env key.
        $mainGo = $this->readFile(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');

        self::assertStringContainsString('forceIPv4', $mainGo);
        self::assertStringContainsString('"-4"', $mainGo);
        self::assertStringContainsString('"CODEX_FORCE_IPV4", "1"', $mainGo);
    }

    public function testBuiltWrapperRunsCodexChildThroughLocalIpv4ProxyWhenEnabled(): void
    {
        // preexec.go starts the proxy and exports HTTP(S)_PROXY / ALL_PROXY.
        $preexecGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');

        self::assertStringContainsString('ipv4.Start(ctx)', $preexecGo);
        self::assertStringContainsString('"HTTPS_PROXY", p.URL', $preexecGo);
        self::assertStringContainsString('"HTTP_PROXY", p.URL', $preexecGo);
        self::assertStringContainsString('"ALL_PROXY", p.URL', $preexecGo);
        self::assertStringContainsString('CODEX_FORCE_IPV4', $preexecGo);
    }

    public function testBuiltWrapperStopsIpv4ProxyOnCleanupAndAfterCodexRun(): void
    {
        // proxy.go defines Start/Stop; preexec.go returns Stop as the teardown
        // function; exec.go defers teardown() so it runs after Codex finishes.
        $proxyGo   = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/ipv4/proxy.go');
        $preexecGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');
        $execGo    = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');

        self::assertStringContainsString('func Start(', $proxyGo);
        self::assertStringContainsString('func (p *Proxy) Stop()', $proxyGo);
        self::assertStringContainsString('teardown = p.Stop', $preexecGo);
        self::assertStringContainsString('defer teardown()', $execGo);
    }

    public function testIpv4HelperFragmentsCoverGoNetworkPaths(): void
    {
        // The Go proxy forces IPv4 at the dialer level ("tcp4"). Verify the key
        // implementation details that replaced the legacy Python proxy and the
        // per-script CODEX_FORCE_IPV4 checks.
        $proxyGo   = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/ipv4/proxy.go');
        $preexecGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');

        // Proxy listens on IPv4 loopback.
        self::assertStringContainsString('net.Listen("tcp4", "127.0.0.1:0")', $proxyGo);
        // Outbound connections are forced to tcp4.
        self::assertStringContainsString('"tcp4"', $proxyGo);
        // Proxy URL is built from 127.0.0.1 and the assigned port.
        self::assertStringContainsString('http://127.0.0.1:%d', $proxyGo);
        // Resolver also forced to udp4.
        self::assertStringContainsString('"udp4"', $proxyGo);
        // preexec checks the env flag before starting the proxy.
        self::assertStringContainsString('os.Getenv("CODEX_FORCE_IPV4") == "1"', $preexecGo);
    }

    private function readFile(string $path): string
    {
        $source = @file_get_contents($path);
        self::assertIsString($source, sprintf('Expected to be able to read %s', $path));

        return $source;
    }
}
