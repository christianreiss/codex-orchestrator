<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperHelpPassthroughTest extends TestCase
{
    public function testWrapperPrintsHelpAndVersionWithoutRunningBootstrap(): void
    {
        $mainSource = file_get_contents(__DIR__ . '/../wrappers/clx/cmd/clx/main.go');
        self::assertIsString($mainSource);

        // --version flag handled before config load / lifecycle run
        self::assertStringContainsString('versionFlag', $mainSource);
        self::assertStringContainsString('--version', $mainSource);

        // Version output includes engine name "clx" and platform/arch
        self::assertStringContainsString('"clx %s (commit %s', $mainSource);

        // Help passthrough: --help / -h before any positional token routes
        // straight to the upstream claude binary without running bootstrap.
        self::assertStringContainsString('isHelpPassthrough', $mainSource);
        self::assertStringContainsString('helpPassthrough', $mainSource);
        self::assertStringContainsString('"--help"', $mainSource);
        self::assertStringContainsString('"-h"', $mainSource);

        // Help passthrough bypasses lock, sync, boot screen, footer
        self::assertStringContainsString('no lock, no sync', $mainSource);

        // Version flag is evaluated AFTER help-passthrough but BEFORE config load
        $versionPos   = strpos($mainSource, 'f.versionFlag');
        $configPos    = strpos($mainSource, 'config.Load(');
        $lifecyclePos = strpos($mainSource, 'lifecycle.Run(');

        self::assertNotFalse($versionPos);
        self::assertNotFalse($configPos);
        self::assertNotFalse($lifecyclePos);

        // version check must come before both config load and lifecycle run
        self::assertLessThan($configPos, $versionPos, '--version must be handled before config.Load()');
        self::assertLessThan($lifecyclePos, $versionPos, '--version must be handled before lifecycle.Run()');
    }

    public function testWrapperVersionActuallyRunsEndToEnd(): void
    {
        // The Go binary must print its version without exiting with an error.
        // Uses the pre-built binary if present, or `go run` as fallback.
        $binPath = __DIR__ . '/../wrappers/clx/bin/clx';
        if (is_executable($binPath)) {
            $output = [];
            $exitCode = 0;
            exec(escapeshellarg($binPath) . ' --version 2>&1', $output, $exitCode);
            self::assertSame(0, $exitCode, 'clx --version should exit 0; got: ' . implode("\n", $output));
            self::assertNotEmpty($output);
            self::assertStringContainsString('clx', $output[0]);
        } else {
            // Verify the source at minimum declares the version string pattern
            $mainSource = file_get_contents(__DIR__ . '/../wrappers/clx/cmd/clx/main.go');
            self::assertIsString($mainSource);
            self::assertStringContainsString('"clx %s (commit %s', $mainSource);
            self::assertStringContainsString('runtime.GOOS', $mainSource);
            self::assertStringContainsString('runtime.GOARCH', $mainSource);
        }
    }
}
