<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperDeferredUpdateTest extends TestCase
{
    public function testCodexUpdateIsDeferredWhenWrapperRestartIsPending(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);
        self::assertStringContainsString('defer_codex_update_for_wrapper=0', $wrapperSource);
        self::assertStringContainsString(
            'Wrapper update to ${precheck_target_wrapper} pending; deferring Codex update until wrapper restart.',
            $wrapperSource
        );
        self::assertStringContainsString('codex_status_label="Deferred"', $wrapperSource);
        self::assertStringContainsString('codex_status_note="waiting for wrapper restart"', $wrapperSource);
        self::assertStringContainsString('update\ available|check\ skipped|update\ skipped|deferred', $wrapperSource);
    }
}
