<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperFqdnGuardTest extends TestCase
{
    public function testWrapperContainsFqdnGuardAndOverride(): void
    {
        // The Go wrapper implements the FQDN guard in codex/preexec.go via the
        // guardFQDN() function, which refuses to proceed when the runtime hostname
        // does not match the FQDN baked into the signed config.

        $preexecSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');
        self::assertIsString($preexecSource, 'Expected to be able to read codex/preexec.go');

        self::assertStringContainsString(
            'func guardFQDN(',
            $preexecSource,
            'Wrapper should define a guardFQDN function.'
        );
        self::assertStringContainsString(
            'guardFQDN',
            $preexecSource,
            'Wrapper should invoke the FQDN guard.'
        );
        self::assertStringContainsString(
            'CODEX_ALLOW_FQDN_MISMATCH',
            $preexecSource,
            'Wrapper should expose CODEX_ALLOW_FQDN_MISMATCH override.'
        );
        self::assertStringContainsString(
            'does not match baked FQDN',
            $preexecSource,
            'Wrapper should emit a clear mismatch error referencing the baked FQDN.'
        );
    }
}
