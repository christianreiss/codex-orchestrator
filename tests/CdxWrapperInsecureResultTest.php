<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureResultTest extends TestCase
{
    public function testWrapperUsesCompactInsecureResultLabel(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'sync ok (insecure host; auth refreshed)',
            $wrapperSource,
            'Expected compact insecure-host result label to be present'
        );
    }
}
