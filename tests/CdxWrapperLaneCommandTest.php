<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperLaneCommandTest extends TestCase
{
    public function testWrapperExposesLaneCommandAndPersistHelper(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('cdx lane normal [--persist] [-- <codex args...>]', $wrapperSource);
        self::assertStringContainsString('persist_lane_preference_with_api()', $wrapperSource);
        self::assertStringContainsString('/host/lane', $wrapperSource);
    }

    public function testWrapperInjectsLaneProfileOrModelWhenLaneSourceIsCommandOrHost(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('CODEX_EFFECTIVE_LANE_SOURCE', $wrapperSource);
        self::assertStringContainsString('config_has_profile "$CODEX_EFFECTIVE_LANE"', $wrapperSource);
        self::assertStringContainsString('gpt-5.4-mini', $wrapperSource);
        self::assertStringContainsString('gpt-5.3-codex', $wrapperSource);
    }

    public function testWrapperGuardsEmptyLanePassthroughBeforeResettingArgv(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('if ((${#lane_passthrough[@]} > 0)); then', $wrapperSource);
        self::assertStringContainsString('set -- "${lane_passthrough[@]}"', $wrapperSource);
        self::assertStringContainsString("else\n    set --\n  fi", $wrapperSource);
    }
}
