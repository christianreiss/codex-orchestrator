<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRestartArgsTest extends TestCase
{
    public function testWrapperRestartPreservesOriginalArgs(): void
    {
        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read wrappers/cdx/cmd/cdx/main.go');

        $updateSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/update/update.go');
        self::assertIsString($updateSource, 'Expected to be able to read wrappers/cdx/internal/update/update.go');

        // argv is snapshotted before any flag parsing so re-exec gets the original args
        self::assertStringContainsString(
            'snap := make([]string, len(args))',
            $mainSource,
            'Wrapper should snapshot argv before shifting positional params.'
        );
        self::assertStringContainsString(
            'copy(snap, args)',
            $mainSource,
            'Wrapper should copy original args into snapshot.'
        );
        self::assertStringContainsString(
            'update.SnapshottedArgv = snap',
            $mainSource,
            'Wrapper should store snapshotted argv for update restart.'
        );
        // SnapshottedArgv is the exported variable that holds the original args
        self::assertStringContainsString(
            'var SnapshottedArgv []string',
            $updateSource,
            'update package should export SnapshottedArgv for re-exec after self-update.'
        );
        // ReExecAfterUpdate is the re-exec entry point that uses the snapshotted argv
        self::assertStringContainsString(
            'func ReExecAfterUpdate(',
            $updateSource,
            'Wrapper self-update restart should re-exec via ReExecAfterUpdate with original argv.'
        );
        // ReExecAfterUpdate uses syscall.Exec so the process is replaced atomically
        self::assertStringContainsString(
            'syscall.Exec(',
            $updateSource,
            'ReExecAfterUpdate should use syscall.Exec to replace the process image.'
        );
        // The restart depth guard prevents feedback loops
        self::assertStringContainsString(
            'CODEX_WRAPPER_RESTART_DEPTH',
            $updateSource,
            'Wrapper should track restart depth to prevent re-exec feedback loops.'
        );
        self::assertStringContainsString(
            'CODEX_WRAPPER_RESTARTED',
            $updateSource,
            'Wrapper should set CODEX_WRAPPER_RESTARTED=1 on restart.'
        );
        // Restart depth guard in main prevents infinite re-exec
        self::assertStringContainsString(
            'maxRestartDepth',
            $mainSource,
            'Wrapper self-update restart should not allow infinite restart loops.'
        );
        // The wrapper must not re-exec with the mutated $@ (exec "$SCRIPT_REAL" "$@" bash pattern)
        self::assertStringNotContainsString(
            'exec "$SCRIPT_REAL" "$@"',
            $mainSource,
            'Wrapper self-update restart should not use mutated args.'
        );
    }
}
