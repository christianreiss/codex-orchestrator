<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureApprovalPendingTest extends TestCase
{
    public function testWrapperPrintsEnableWindowHintWhileApprovalIsPending(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'Insecure host approval pending. Open Admin and click "Enable window" for this host.',
            $wrapperSource
        );
        self::assertStringContainsString(
            'Insecure host approval pending; open Admin and click \"Enable window\" for this host (polling every 5s).',
            $wrapperSource
        );
    }
}
