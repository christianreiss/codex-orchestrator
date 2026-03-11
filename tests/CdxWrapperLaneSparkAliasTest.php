<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperLaneSparkAliasTest extends TestCase
{
    public function testWrapperRewritesLsToSparkLaneBeforeLaneParsing(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $aliasPos = strpos($wrapperSource, 'if [[ "${1-}" == "ls" ]]; then');
        $lanePos = strpos($wrapperSource, 'if [[ "${1-}" == "lane" ]]; then');

        self::assertNotFalse($aliasPos, 'Expected ls alias rewrite in wrapper source');
        self::assertNotFalse($lanePos, 'Expected lane parser in wrapper source');
        self::assertStringContainsString('set -- lane spark "$@"', $wrapperSource);
        self::assertLessThan($lanePos, $aliasPos, 'Expected ls alias rewrite to happen before lane parsing');
    }
}
