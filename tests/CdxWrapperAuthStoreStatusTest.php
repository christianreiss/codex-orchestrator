<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperAuthStoreStatusTest extends TestCase
{
    public function testWrapperNormalizesSuccessfulStoreToValidAuthStatus(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if normalized_status in ("updated", "unchanged"):', $wrapperSource);
        self::assertStringContainsString('status = "valid"', $wrapperSource);
        self::assertStringContainsString(
            '"auth_action": ("store" if (did_store and status == "valid") else status or "unknown")',
            $wrapperSource
        );
    }
}
