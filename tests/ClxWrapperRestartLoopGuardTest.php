<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperRestartLoopGuardTest extends TestCase
{
    public function testSelfUpdateCarriesRestartDepthEnvVar(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/04-update.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('CLAUDE_WRAPPER_RESTART_DEPTH', $fragment);
        self::assertStringContainsString('if (( depth > 2 )); then', $fragment);
        self::assertStringContainsString('exec env CLAUDE_WRAPPER_RESTART_DEPTH="$depth"', $fragment);
    }
}
