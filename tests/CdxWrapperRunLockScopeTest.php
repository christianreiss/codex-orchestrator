<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperRunLockScopeTest extends TestCase
{
    public function testRunLockScopeIncludesUidSuffix(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'uid="$(id -u 2>/dev/null || true)"',
            $wrapperSource,
            'Run lock scope should key on numeric UID when available.'
        );
        self::assertStringContainsString(
            'user_scope="u${uid}"',
            $wrapperSource,
            'Run lock scope should encode UID into the lock key.'
        );
        self::assertStringContainsString(
            'sanitize_lock_token "${base_scope}-${user_scope}"',
            $wrapperSource,
            'Run lock scope should append user scope to installation/API scope.'
        );
    }

    public function testRunLockScopeHasUserFallbackWhenUidLookupFails(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'user_scope="user-$(sanitize_lock_token "$CURRENT_USER")"',
            $wrapperSource,
            'Run lock scope should fall back to sanitized username when UID cannot be determined.'
        );
    }
}
