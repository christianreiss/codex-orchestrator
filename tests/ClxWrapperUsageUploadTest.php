<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperUsageUploadTest extends TestCase
{
    public function testUsagePingUsesCorrectEndpointAndEngine(): void
    {
        $run = file_get_contents(__DIR__ . '/../bin/clx.d/05-main-50-run.sh');
        self::assertIsString($run);

        self::assertStringContainsString('clx_record_usage()', $run);
        self::assertStringContainsString('${CLAUDE_SYNC_BASE_URL}/usage', $run);
        // The jq invocation builds the engine field via --arg engine "claude".
        self::assertStringContainsString('--arg engine "claude"', $run);
        self::assertStringContainsString('--arg fqdn "$CLAUDE_SYNC_FQDN"', $run);
    }

    public function testSessionJsonlExtractorIsReferenced(): void
    {
        $run = file_get_contents(__DIR__ . '/../bin/clx.d/05-main-50-run.sh');
        self::assertIsString($run);

        self::assertStringContainsString('send_claude_usage_from_session_jsonl', $run);
    }

    public function testExtractionFragmentExists(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-50-usage.sh');
        self::assertIsString($fragment);
        self::assertStringContainsString('send_claude_usage_from_session_jsonl', $fragment);
    }
}
