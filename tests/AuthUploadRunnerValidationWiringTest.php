<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Runner verification now runs in the preflight-cron tick, not inline during upload.
 * These tests just assert the wiring stays intact (upload endpoints still consume
 * the seed token after handleAuth and still pass skipRunner=false so future runner
 * probes continue to see real data when the cron promotes pending rows).
 */
final class AuthUploadRunnerValidationWiringTest extends TestCase
{
    public function testAdminAuthUploadDoesNotSkipRunnerValidation(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($source);
        self::assertStringContainsString("'admin-upload'", $source);
        self::assertStringContainsString("\n                false\n            );", $source);
    }

    public function testSeedAuthUploadDoesNotSkipRunnerValidation(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/InstallController.php');
        self::assertIsString($source);
        self::assertStringContainsString("'seed-upload'", $source);
        self::assertStringContainsString("\n                false\n            );", $source);
    }

    public function testSeedAuthUploadConsumesTokenAfterStoreValidation(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/InstallController.php');
        self::assertIsString($source);

        $storePosition = strpos($source, '$result = $this->service->handleAuth(');
        $consumePosition = strrpos($source, '$this->seedTokenRepository->markUsed((int) $tokenRow[\'id\']);');

        self::assertIsInt($storePosition);
        self::assertIsInt($consumePosition);
        self::assertGreaterThan($storePosition, $consumePosition);
    }

    public function testSeedAuthUploadSetsPreflightForceRunMarker(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/InstallController.php');
        self::assertIsString($source);
        self::assertStringContainsString("'preflight_force_run'", $source);
    }

    public function testHotPathAuthServiceHasNoSyncRunnerProbe(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        self::assertIsString($source);
        // The store/retrieve hot path must not invoke runnerDailyCheck or enforceRunnerValidationOnFailure.
        self::assertStringNotContainsString('runnerDailyCheck(', $source);
        self::assertStringNotContainsString('enforceRunnerValidationOnFailure(', $source);
    }

    public function testIndexPhpDoesNotRunDailyPreflight(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($source);
        self::assertStringNotContainsString('$service->runDailyPreflight', $source);
    }
}
