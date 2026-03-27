<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperInsecureApprovalPendingTest extends TestCase
{
    public function testWrapperRendersSinglePendingApprovalBoxWhilePolling(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'build_insecure_approval_pending_box() {',
            $wrapperSource
        );
        self::assertStringContainsString(
            'render_insecure_approval_pending_box() {',
            $wrapperSource
        );
        self::assertStringContainsString(
            'Pending; open Admin, click Enable window',
            $wrapperSource
        );
        self::assertStringContainsString(
            'format_approval_box_field "last check:"',
            $wrapperSource
        );
        self::assertStringContainsString(
            'format_approval_box_field "checks:"',
            $wrapperSource
        );
        self::assertStringContainsString(
            "printf '\\033[%sA' \"\$INSECURE_APPROVAL_BOX_LINES\"",
            $wrapperSource
        );
        self::assertStringContainsString(
            'INSECURE_APPROVAL_CHECK_COUNT=$(( INSECURE_APPROVAL_CHECK_COUNT + 1 ))',
            $wrapperSource
        );
        self::assertStringNotContainsString(
            'wait_logged=1',
            $wrapperSource,
            'Pending approval should redraw the same box instead of logging a one-time wait flag.'
        );
    }
}
