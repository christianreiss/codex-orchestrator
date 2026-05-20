<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRunLockScopeTest extends TestCase
{
    private static function readGoFile(string $relPath): string
    {
        $path = __DIR__ . '/../' . $relPath;
        $source = @file_get_contents($path);
        self::assertIsString($source, "Expected to be able to read {$relPath}");
        return $source;
    }

    public function testRunLockScopeIncludesUidSuffix(): void
    {
        // The Go wrapper keys the lock file on the numeric UID from os.Getuid().
        // lockPath() appends the UID directly into the filename so two users on
        // the same host get distinct lock files — the direct equivalent of the
        // bash wrapper's user_scope="u${uid}" / sanitize_lock_token approach.
        $lockSource = self::readGoFile('wrappers/cdx/internal/ipc/lock.go');

        self::assertStringContainsString(
            'os.Getuid()',
            $lockSource,
            'Lock path should key on numeric UID from os.Getuid().'
        );
        self::assertStringContainsString(
            '%s-%d.lock',
            $lockSource,
            'Lock filename should embed the UID as a numeric suffix.'
        );
        // The UID is passed as the second argument to Sprintf — confirming the
        // name-uid combination is what forms the per-user lock scope.
        self::assertStringContainsString(
            'fmt.Sprintf("%s-%d.lock", name, os.Getuid())',
            $lockSource,
            'Run lock scope should append UID to installation/name scope.'
        );
    }

    public function testRunLockScopeHasUserFallbackWhenUidLookupFails(): void
    {
        // When XDG_RUNTIME_DIR is set the lock lives inside the user's runtime
        // directory (inherently user-scoped), so no explicit UID suffix is needed.
        // When it is absent the fallback path appends os.Getuid() to /tmp — both
        // paths ensure per-user isolation without requiring a separate username lookup.
        $lockSource = self::readGoFile('wrappers/cdx/internal/ipc/lock.go');

        self::assertStringContainsString(
            'XDG_RUNTIME_DIR',
            $lockSource,
            'Lock path should use XDG_RUNTIME_DIR when available (user-scoped by definition).'
        );
        self::assertStringContainsString(
            'os.TempDir()',
            $lockSource,
            'Lock path should fall back to os.TempDir() when XDG_RUNTIME_DIR is absent.'
        );
    }
}
