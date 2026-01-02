<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperAuthValidationTest extends TestCase
{
    public function testWrapperAcceptsTokenFallbackInAuthValidation(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $start = strpos($wrapperSource, 'validate_auth_json_file()');
        self::assertNotFalse($start, 'Expected validate_auth_json_file in wrapper');
        $end = strpos($wrapperSource, 'push_auth_if_changed()', $start);
        self::assertNotFalse($end, 'Expected push_auth_if_changed in wrapper');

        $segment = substr($wrapperSource, $start, $end - $start);
        self::assertStringContainsString('tokens', $segment, 'Expected tokens fallback in validation');
        self::assertStringContainsString('access_token', $segment, 'Expected access_token fallback in validation');
        self::assertStringContainsString('OPENAI_API_KEY', $segment, 'Expected OPENAI_API_KEY fallback in validation');
    }
}
