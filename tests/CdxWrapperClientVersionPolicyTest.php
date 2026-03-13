<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperClientVersionPolicyTest extends TestCase
{
    public function testBuiltWrapperCarriesClientVersionExactnessFlag(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('client_version_enforce_exact', $wrapperSource);
        self::assertStringContainsString('SYNC_REMOTE_CLIENT_VERSION_ENFORCE_EXACT', $wrapperSource);
        self::assertStringContainsString('cvx=1', $wrapperSource);
        self::assertStringContainsString('cvx=0', $wrapperSource);
    }

    public function testBuiltWrapperFallsBackToLockedSourceWhenExactnessFlagIsMissing(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('case "$(lowercase "${SYNC_REMOTE_CLIENT_VERSION_ENFORCE_EXACT:-}")" in', $wrapperSource);
        self::assertStringContainsString('if [[ "${SYNC_REMOTE_CLIENT_VERSION_SOURCE:-}" == "locked" ]]; then', $wrapperSource);
    }
}
