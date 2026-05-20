<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperLaneSparkAliasTest extends TestCase
{
    public function testWrapperRewritesLsToSparkLaneBeforeLaneParsing(): void
    {
        // In Go (main.go), `cdx ls` is rewritten to `cdx lane spark` before
        // the switch-case dispatch that handles the `lane` subcommand.
        $mainGo = $this->readFile(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');

        // The ls alias rewrite occurs before the switch (cmdLane call).
        $aliasPos = strpos($mainGo, 'sub == "ls"');
        $lanePos  = strpos($mainGo, 'case "lane":');

        self::assertNotFalse($aliasPos, 'Expected ls alias rewrite in Go main.go');
        self::assertNotFalse($lanePos, 'Expected lane case in Go main.go');

        // The rewrite sets sub to "lane" and prepends "spark" to subArgs.
        self::assertStringContainsString('sub = "lane"', $mainGo);
        self::assertStringContainsString('subArgs = []string{"spark"}', $mainGo);

        // The alias rewrite happens before the switch-case dispatch.
        self::assertLessThan($lanePos, $aliasPos, 'Expected ls alias rewrite to happen before lane dispatch');
    }

    private function readFile(string $path): string
    {
        $source = @file_get_contents($path);
        self::assertIsString($source, sprintf('Expected to be able to read %s', $path));

        return $source;
    }
}
