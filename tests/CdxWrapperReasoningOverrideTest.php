<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperReasoningOverrideTest extends TestCase
{
    public function testWrapperUsesConfigOverrideForReasoningEffort(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'model_reasoning_effort=',
            $wrapperSource,
            'Wrapper should pass reasoning effort via config overrides.'
        );
        self::assertStringNotContainsString(
            '--reasoning-effort',
            $wrapperSource,
            'Wrapper should not pass the legacy --reasoning-effort flag.'
        );
    }
}
