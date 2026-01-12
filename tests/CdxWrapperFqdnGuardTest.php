<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperFqdnGuardTest extends TestCase
{
    public function testWrapperContainsFqdnGuardAndOverride(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'enforce_baked_fqdn_guard()',
            $wrapperSource,
            'Wrapper should define an FQDN guard.'
        );
        self::assertStringContainsString(
            'enforce_baked_fqdn_guard',
            $wrapperSource,
            'Wrapper should invoke the FQDN guard.'
        );
        self::assertStringContainsString(
            'CODEX_ALLOW_FQDN_MISMATCH',
            $wrapperSource,
            'Wrapper should expose CODEX_ALLOW_FQDN_MISMATCH override.'
        );
        self::assertStringContainsString(
            'Host mismatch: baked for',
            $wrapperSource,
            'Wrapper should emit a clear mismatch error.'
        );
    }
}
