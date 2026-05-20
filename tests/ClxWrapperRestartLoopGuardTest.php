<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperRestartLoopGuardTest extends TestCase
{
    public function testSelfUpdateCarriesRestartDepthEnvVar(): void
    {
        // update.go increments CLAUDE_WRAPPER_RESTART_DEPTH and re-execs via
        // syscall.Exec so main.go can detect runaway restart loops.
        $updateGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/update/update.go');
        self::assertIsString($updateGo);

        self::assertStringContainsString('CLAUDE_WRAPPER_RESTART_DEPTH', $updateGo);
        self::assertStringContainsString('ReExecAfterUpdate', $updateGo);
        self::assertStringContainsString('syscall.Exec', $updateGo);
    }

    public function testMainBailsOutAboveMaxDepth(): void
    {
        // main.go caps restarts at maxRestartDepth == 2 and exits when exceeded.
        $mainGo = file_get_contents(__DIR__ . '/../wrappers/clx/cmd/clx/main.go');
        self::assertIsString($mainGo);

        self::assertStringContainsString('CLAUDE_WRAPPER_RESTART_DEPTH', $mainGo);
        self::assertStringContainsString('maxRestartDepth = 2', $mainGo);
        self::assertStringContainsString('depth > maxRestartDepth', $mainGo);
        self::assertStringContainsString('refusing to continue', $mainGo);
    }
}
