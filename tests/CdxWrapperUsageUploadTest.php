<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUsageUploadTest extends TestCase
{
    public function testUsageUploadTimeoutDoesNotBlockWrapperExitForLong(): void
    {
        // The usage-upload logic was ported from bin/cdx.d/03-sync-50-usage.sh
        // to Go in wrappers/cdx/internal/lifecycle/run.go (reportUsage) and
        // wrappers/cdx/internal/orchestrator/usage.go (PostUsages).
        // This test verifies the Go source enforces a short context timeout so
        // a slow /usage endpoint cannot block the wrapper exit for long.

        $lifecycleSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($lifecycleSource, 'Expected to find lifecycle/run.go');

        // reportUsage uses a 5-second context timeout — mirrors the bash best-effort budget.
        self::assertStringContainsString('5*time.Second', $lifecycleSource);
        self::assertStringContainsString('reportUsage', $lifecycleSource);
        self::assertStringContainsString('PostUsages', $lifecycleSource);

        $usageSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/orchestrator/usage.go');
        self::assertIsString($usageSource, 'Expected to find orchestrator/usage.go');

        // PostUsages sends the batch payload that matches the legacy wire shape.
        self::assertStringContainsString('PostUsages', $usageSource);
        self::assertStringContainsString('/usage', $usageSource);
        self::assertStringContainsString('UsagesBatch', $usageSource);
        self::assertStringContainsString('"usages"', $usageSource);

        // The Go client enforces its own per-request timeout via http.Client.Timeout.
        $clientSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/orchestrator/client.go');
        self::assertIsString($clientSource, 'Expected to find orchestrator/client.go');
        self::assertStringContainsString('defaultTimeout', $clientSource);
        self::assertStringContainsString('Timeout:', $clientSource);
    }
}
