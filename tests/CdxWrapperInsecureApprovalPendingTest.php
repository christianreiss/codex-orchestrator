<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureApprovalPendingTest extends TestCase
{
    public function testWrapperRendersSinglePendingApprovalBoxWhilePolling(): void
    {
        $sourcePath = __DIR__ . '/../wrappers/cdx/internal/ui/approval_box.go';
        $source = @file_get_contents($sourcePath);
        self::assertIsString($source, 'Expected to be able to read wrappers/cdx/internal/ui/approval_box.go');

        self::assertStringContainsString(
            'func PollApproval(',
            $source,
            'Should export a PollApproval function that drives the polling loop.'
        );
        self::assertStringContainsString(
            'func drawApprovalBox(',
            $source,
            'Should have an internal drawApprovalBox function that renders the framed box.'
        );
        self::assertStringContainsString(
            'Awaiting insecure-host approval',
            $source,
            'Pending approval box should display an "awaiting" title.'
        );
        self::assertStringContainsString(
            'last check',
            $source,
            'Pending approval box should show a "last check" timestamp field.'
        );
        self::assertStringContainsString(
            'checks',
            $source,
            'Pending approval box should show a poll-counter field.'
        );
        self::assertStringContainsString(
            '\033[1A\033[2K',
            $source,
            'Subsequent repaints should walk the cursor up and erase lines to redraw in place.'
        );
        self::assertStringContainsString(
            'checks++',
            $source,
            'Poll counter should increment on each tick.'
        );
        self::assertStringNotContainsString(
            'wait_logged',
            $source,
            'Pending approval should redraw the same box instead of logging a one-time wait flag.'
        );
    }
}
