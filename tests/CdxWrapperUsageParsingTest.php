<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUsageParsingTest extends TestCase
{
    /**
     * The usage-parsing logic was ported from a Python script embedded in
     * bin/cdx.d/03-sync-50-usage.sh to pure Go in
     * wrappers/cdx/internal/codex/usage.go. These tests verify that the
     * canonical parsing contracts exist in the Go source.
     */

    public function testWrapperParsesLegacyTokenUsageLines(): void
    {
        $usageSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/usage.go');
        self::assertIsString($usageSource, 'Expected to be able to read codex/usage.go');

        // Legacy "Token usage: total=N input=N output=N" line parser.
        self::assertStringContainsString('Token usage', $usageSource);
        self::assertStringContainsString('total=', $usageSource);
        self::assertStringContainsString('input=', $usageSource);
        self::assertStringContainsString('output=', $usageSource);
        self::assertStringContainsString('ParseStdoutCapture', $usageSource);
        self::assertStringContainsString('tokenUsagePattern', $usageSource);
    }

    public function testWrapperPrefersStructuredUsageFromSessionJsonl(): void
    {
        $usageSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/usage.go');
        self::assertIsString($usageSource, 'Expected to be able to read codex/usage.go');

        // JSONL session file discovery and parsing.
        self::assertStringContainsString('ParseSessionJSONL', $usageSource);
        self::assertStringContainsString('DiscoverSessions', $usageSource);
        self::assertStringContainsString('token_count', $usageSource);
        self::assertStringContainsString('last_token_usage', $usageSource);
        self::assertStringContainsString('input_tokens', $usageSource);
        self::assertStringContainsString('cached_input_tokens', $usageSource);
        self::assertStringContainsString('output_tokens', $usageSource);
        self::assertStringContainsString('reasoning_output_tokens', $usageSource);
        self::assertStringContainsString('total_tokens', $usageSource);

        // The lifecycle prefers JSONL when the stdout capture has no usage line.
        $lifecycleSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($lifecycleSource, 'Expected to be able to read lifecycle/run.go');
        self::assertStringContainsString('ParseStdoutCapture', $lifecycleSource);
        self::assertStringContainsString('DiscoverSessions', $lifecycleSource);
        self::assertStringContainsString('ParseSessionJSONL', $lifecycleSource);
    }

    public function testWrapperFallsBackToCurrentTokensUsedFooter(): void
    {
        $usageSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/usage.go');
        self::assertIsString($usageSource, 'Expected to be able to read codex/usage.go');

        // The "tokens used\nN,NNN" footer pattern from newer Codex CLI versions
        // is handled: ParseStdoutCapture scans lines for "token usage" case-insensitively.
        self::assertStringContainsString('(?i)', $usageSource);
        self::assertStringContainsString('token usage', $usageSource);

        // Thousands separators are stripped.
        self::assertStringContainsString('strings.ReplaceAll', $usageSource);
    }

    public function testWrapperFastPathsTailTokenUsageBeforeSessionJsonlFallback(): void
    {
        $usageSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/usage.go');
        self::assertIsString($usageSource, 'Expected to be able to read codex/usage.go');

        // The stdout capture is ring-buffered to captureMaxBytes so we only
        // scan the tail for the "Token usage:" line.
        $execSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        self::assertIsString($execSource, 'Expected to be able to read codex/exec.go');
        self::assertStringContainsString('captureMaxBytes', $execSource);
        self::assertStringContainsString('ringBuffer', $execSource);

        // ParseStdoutCapture scans right-to-left (last match = authoritative total).
        self::assertStringContainsString('for i := len(lines) - 1; i >= 0; i--', $usageSource);
    }

    public function testWrapperFallsBackToFullFileLegacyParseWhenTailMissesTokenUsage(): void
    {
        $lifecycleSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/lifecycle/run.go');
        self::assertIsString($lifecycleSource, 'Expected to be able to read lifecycle/run.go');

        // When ParseStdoutCapture finds nothing, the lifecycle falls back to
        // walking the JSONL session directory.
        self::assertStringContainsString('tokens.IsZero()', $lifecycleSource);
        self::assertStringContainsString('DiscoverSessions', $lifecycleSource);
        self::assertStringContainsString('ParseSessionJSONL', $lifecycleSource);

        $usageSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/usage.go');
        self::assertIsString($usageSource);
        self::assertStringContainsString('IsZero()', $usageSource);
    }
}
