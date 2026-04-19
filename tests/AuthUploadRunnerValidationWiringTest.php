<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

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
}
