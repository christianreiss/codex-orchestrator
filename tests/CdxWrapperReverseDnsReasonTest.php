<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperReverseDnsReasonTest extends TestCase
{
    public function testWrapperSurfacesReverseDnsMismatchReason(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'reverse DNS mismatch',
            $wrapperSource,
            'Expected wrapper to surface reverse DNS mismatch reason for denied auth syncs.'
        );
    }
}
