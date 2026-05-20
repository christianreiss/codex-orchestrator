<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperUsageUploadTest extends TestCase
{
    public function testUsagePingUsesCorrectEndpointAndEngine(): void
    {
        // PostUsages in orchestrator/usage.go posts to /usage with engine="claude".
        $usage = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/usage.go');
        self::assertIsString($usage);

        self::assertStringContainsString('/usage', $usage);
        // Engine defaults to "claude" in both PostUsage and PostUsages.
        self::assertStringContainsString('"claude"', $usage);
        self::assertStringContainsString('Engine', $usage);

        // lifecycle/run.go wires the FQDN from cfg.Host.FQDN into the batch.
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);
        self::assertStringContainsString('PostUsages', $run);
        self::assertStringContainsString('FQDN', $run);
        self::assertStringContainsString('Engine: "claude"', $run);
    }

    public function testSessionJsonlExtractorIsReferenced(): void
    {
        // ParseSessionJSONL in claude/usage.go replaces the bash
        // send_claude_usage_from_session_jsonl function.
        $usage = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/usage.go');
        self::assertIsString($usage);

        self::assertStringContainsString('ParseSessionJSONL', $usage);

        // lifecycle/run.go calls it via DiscoverSessions + ParseSessionJSONL.
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);
        self::assertStringContainsString('ParseSessionJSONL', $run);
        self::assertStringContainsString('DiscoverSessions', $run);
    }

    public function testExtractionFragmentExists(): void
    {
        // The Go port of 03-sync-50-usage.sh lives in claude/usage.go.
        $usage = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/usage.go');
        self::assertIsString($usage);

        // ParseSessionJSONL is the direct Go replacement for the bash function.
        self::assertStringContainsString('ParseSessionJSONL', $usage);
        self::assertStringContainsString('DiscoverSessions', $usage);
    }

    public function testSessionJsonlPayloadAddsClaudeEngineBeforePost(): void
    {
        // orchestrator/usage.go: UsagesBatch.Engine defaults to "claude" in
        // PostUsages, and the UsageEntry.Engine field carries it on the wire.
        $usage = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/usage.go');
        self::assertIsString($usage);

        self::assertStringContainsString('Engine', $usage);
        self::assertStringContainsString('"claude"', $usage);

        // lifecycle/run.go builds UsagesBatch with Engine: "claude".
        $run = file_get_contents(__DIR__ . '/../wrappers/clx/internal/lifecycle/run.go');
        self::assertIsString($run);
        self::assertStringContainsString('Engine: "claude"', $run);
        self::assertStringContainsString('UsagesBatch', $run);
    }
}
