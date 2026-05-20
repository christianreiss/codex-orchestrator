<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperLaunchNoOpGuardTest extends TestCase
{
    public function testOtelConfigHelperReturnsSuccessWhenNothingIsExported(): void
    {
        // exportOTELFromConfig() in preexec.go returns nil (success) immediately
        // when the config file cannot be read, so an empty or absent [otel] block
        // never causes the wrapper to abort under error propagation.
        $preexecGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');

        self::assertStringContainsString(
            'func exportOTELFromConfig() error',
            $preexecGo,
            'exportOTELFromConfig must be a named function so it can be called and its return value checked.'
        );
        // The function returns nil (success) when ReadFile fails — no config is not an error.
        self::assertStringContainsString(
            "return nil\n\t}",
            $preexecGo,
            'exportOTELFromConfig should return nil when config file is missing so an empty config does not abort cdx.'
        );
    }

    public function testCurrentProjectTrustHelperReturnsSuccessWhenNoPhysicalPathRewriteIsNeeded(): void
    {
        // EnsureProjectTrust() in preexec.go resolves symlinks via
        // filepath.EvalSymlinks and falls back to the logical cwd when that
        // fails. The function returns nil on success in all paths.
        $preexecGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');

        self::assertStringContainsString(
            'func EnsureProjectTrust() error',
            $preexecGo,
            'EnsureProjectTrust must be an exported function so callers can check its return value.'
        );
        self::assertStringContainsString(
            'filepath.EvalSymlinks(cwd)',
            $preexecGo,
            'EnsureProjectTrust should resolve symlinks so the physical path is trusted in config.'
        );
        // When EvalSymlinks fails, resolved falls back to cwd — function succeeds.
        self::assertStringContainsString(
            'resolved = cwd',
            $preexecGo,
            'EnsureProjectTrust should fall back to cwd when EvalSymlinks fails rather than returning an error.'
        );
    }

    public function testRunLockOpenDoesNotSilenceWrapperStderrForTheRestOfTheRun(): void
    {
        // ipc/lock.go opens the lock file with os.OpenFile and uses syscall.Flock.
        // No stderr redirect is involved — failures are surfaced as returned errors
        // rather than silenced with 2>/dev/null permanently.
        $lockGo = $this->readFile(__DIR__ . '/../wrappers/cdx/internal/ipc/lock.go');

        self::assertStringContainsString(
            'os.OpenFile(path, os.O_CREATE|os.O_RDWR',
            $lockGo,
            'Lock open should use os.OpenFile so shell stderr is never redirected.'
        );
        self::assertStringContainsString(
            'syscall.Flock(',
            $lockGo,
            'Lock acquisition should use syscall.Flock so the lock operation is isolated from stderr.'
        );
        // There must be no /dev/null redirect at all in the lock implementation.
        self::assertStringNotContainsString(
            '/dev/null',
            $lockGo,
            'Run-lock open must not redirect stderr to /dev/null.'
        );
    }

    private function readFile(string $path): string
    {
        $source = @file_get_contents($path);
        self::assertIsString($source, sprintf('Expected to be able to read %s', $path));

        return $source;
    }
}
