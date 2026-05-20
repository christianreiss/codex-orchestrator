<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUninstallTest extends TestCase
{
    public function testUninstallIsDeferredUntilAfterConfigHelpersLoad(): void
    {
        // In the Go wrapper, uninstall is a proper subcommand (uninstall.Run)
        // invoked only after config.Load() validates and loads the signed config.
        // This replaces the bash "CODEX_DO_UNINSTALL" deferred-flag pattern.
        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        // --uninstall flag is parsed.
        self::assertStringContainsString('--uninstall', $mainSource);
        self::assertStringContainsString('uninstallFlag', $mainSource);

        // Config is loaded before the uninstall subcommand is dispatched.
        $configLoadPos = strpos($mainSource, 'config.Load(');
        self::assertNotFalse($configLoadPos, 'Expected config.Load call in main.go');

        $uninstallCallPos = strpos($mainSource, 'uninstall.Run(');
        self::assertNotFalse($uninstallCallPos, 'Expected uninstall.Run call in main.go');
        self::assertGreaterThan($configLoadPos, $uninstallCallPos, 'Expected uninstall call to run after config is loaded');

        // The uninstall package contains the actual removal logic.
        $uninstallSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/uninstall/uninstall.go');
        self::assertIsString($uninstallSource, 'Expected to be able to read uninstall/uninstall.go');

        // Uninstall removes the key local artefacts.
        self::assertStringContainsString('auth.json', $uninstallSource);
        self::assertStringContainsString('AGENTS.md', $uninstallSource);
        self::assertStringContainsString('config.toml', $uninstallSource);

        // Multi-user safety check is preserved.
        self::assertStringContainsString('uninstall refused: multi-user host', $uninstallSource);

        // Cron entry is also removed during uninstall.
        self::assertStringContainsString('cron.Remove()', $uninstallSource);
    }
}
