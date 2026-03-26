<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperConcurrentGuardTest extends TestCase
{
    public function testWrapperParsesConcurrentSyncOverrideFlag(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('--allow-concurrent-sync', $wrapperSource);
        self::assertStringContainsString('CODEX_CONCURRENT_SYNC_OVERRIDE=1', $wrapperSource);
    }

    public function testWrapperSkipsMutatingSyncWhenConcurrentRunDetected(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('acquire_run_lock_or_mark_concurrent', $wrapperSource);
        self::assertStringContainsString('AUTH_PULL_STATUS="concurrent"', $wrapperSource);
        self::assertStringContainsString('sync_auth_with_api "pull-readonly" "1"', $wrapperSource);
        self::assertStringContainsString('CODEX_SYNC_READ_ONLY="$read_only"', $wrapperSource);
        self::assertStringContainsString('if (( read_only == 0 )) && [[ -f "$auth_path" ]]', $wrapperSource);
        self::assertStringContainsString('push_auth_if_changed "push" || true', $wrapperSource);
        self::assertStringNotContainsString('skipping pre-run sync/update mutations for this run', $wrapperSource);
        self::assertStringNotContainsString('using local auth.json with sync/update mutations skipped', $wrapperSource);
        self::assertStringNotContainsString('AUTH_PUSH_REASON="active cdx run"', $wrapperSource);
    }

    public function testConcurrentAuthBranchUsesLocalValidation(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString("concurrent)\n", $wrapperSource);
        self::assertStringContainsString('if (( HAS_VALID_LOCAL_AUTH )); then', $wrapperSource);
        self::assertStringContainsString('Using local auth.json.', $wrapperSource);
        self::assertStringContainsString('Local auth.json is invalid.', $wrapperSource);
        self::assertStringContainsString('Local auth.json is missing.', $wrapperSource);
    }

    public function testReadOnlyQuotaParserHandlesMissingUsageAndNumericStrings(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('chatgpt_usage_raw = payload_data.get("chatgpt_usage") if isinstance(payload_data, dict) else {}', $wrapperSource);
        self::assertStringContainsString('chatgpt_usage = chatgpt_usage_raw if isinstance(chatgpt_usage_raw, dict) else {}', $wrapperSource);
        self::assertStringContainsString('import json, os, re, sys', $wrapperSource);
        self::assertStringContainsString('if re.fullmatch(r"-?\\d+(?:\\.\\d+)?", normalized):', $wrapperSource);
    }

    public function testAuthPushChangeDetectionUsesAuthHashAndLastRefresh(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('ORIGINAL_AUTH_SHA="$(sha256_file "$HOME/.codex/auth.json" 2>/dev/null || true)"', $wrapperSource);
        self::assertStringContainsString('refreshed_sha="$(sha256_file "$auth_path" 2>/dev/null || true)"', $wrapperSource);
        self::assertStringContainsString('if [[ "$refreshed" == "$ORIGINAL_LAST_REFRESH" && "$refreshed_sha" == "$ORIGINAL_AUTH_SHA" ]]; then', $wrapperSource);
    }

}
