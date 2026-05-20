<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperReverseDnsReasonTest extends TestCase
{
    public function testWrapperSurfacesReverseDnsMismatchReason(): void
    {
        $authDecideSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/orchestrator/auth_decide.go');
        self::assertIsString($authDecideSource, 'Expected to be able to read wrappers/cdx/internal/orchestrator/auth_decide.go');

        self::assertStringContainsString(
            'reverse DNS mismatch',
            $authDecideSource,
            'Expected wrapper to surface reverse DNS mismatch reason for denied auth syncs.'
        );
    }
}
