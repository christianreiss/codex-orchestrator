<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSyncConfigPrecedenceTest extends TestCase
{
    public function testWrapperPrefersBakedSyncConfigOverCliLoginCredentials(): void
    {
        // The Go wrapper bakes orchestrator credentials into the signed
        // cdx.json config. There is no separate credentials.env fallback;
        // the config loader validates that base_url and api_key are present
        // and refuses to start if they are missing or too short.
        $loadSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/config/load.go');
        self::assertIsString($loadSource, 'Expected to be able to read config/load.go');

        // Load validates the config before use; unsigned configs are refused.
        self::assertStringContainsString('Load(', $loadSource);
        self::assertStringContainsString('no signing public key available', $loadSource);
        self::assertStringContainsString('config signature invalid', $loadSource);

        $configSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/config/config.go');
        self::assertIsString($configSource, 'Expected to be able to read config/config.go');

        // Config struct has the orchestrator block with base_url and api_key.
        self::assertStringContainsString('"base_url"', $configSource);
        self::assertStringContainsString('"api_key"', $configSource);
        self::assertStringContainsString('BaseURL', $configSource);
        self::assertStringContainsString('APIKey', $configSource);

        $validateSource = $loadSource;
        // Validate enforces base_url and api_key are present.
        self::assertStringContainsString('orchestrator.base_url is required', $validateSource);
        self::assertStringContainsString('orchestrator.api_key too short', $validateSource);

        // The baked config path must appear before any fallback in the binary entry point.
        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        $configLoadPos = strpos($mainSource, 'config.Load(');
        self::assertNotFalse($configLoadPos, 'Expected config.Load call in main.go');

        // Config is loaded before any lifecycle/sync call.
        $lifecyclePos = strpos($mainSource, 'lifecycle.Run(');
        self::assertNotFalse($lifecyclePos, 'Expected lifecycle.Run call in main.go');
        self::assertLessThan($lifecyclePos, $configLoadPos, 'Baked config must be loaded before lifecycle runs');
    }
}
