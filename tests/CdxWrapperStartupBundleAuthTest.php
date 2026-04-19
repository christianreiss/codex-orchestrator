<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperStartupBundleAuthTest extends TestCase
{
    public function testWrapperUsesStartupBundleForAuthWhenLocalAuthIsAlreadyValid(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('startup_bundle_can_include_auth() {', $wrapperSource);
        self::assertStringContainsString('if startup_bundle_can_include_auth "$HOME/.codex/auth.json"; then', $wrapperSource);
        self::assertStringContainsString('CODEX_SYNC_INCLUDE_AUTH="$include_auth"', $wrapperSource);
        self::assertStringContainsString('"include_auth": include_auth', $wrapperSource);
        self::assertStringContainsString('auth_store_needed = (', $wrapperSource);
        self::assertStringContainsString('auth_status in ("missing", "upload_required")', $wrapperSource);
        self::assertStringContainsString('if phase == "update" or auth_store_needed:', $wrapperSource);
        self::assertStringContainsString('bootstrap_payload["auth_candidate"] = current_auth', $wrapperSource);
        self::assertStringContainsString('auth_result = normalize_auth_summary(', $wrapperSource);
        self::assertStringContainsString('auth = parsed.get("auth")', $wrapperSource);
        self::assertStringContainsString('auth_lines="$(emit_auth_sync_lines_from_json "$auth_summary" || true)"', $wrapperSource);
        self::assertStringContainsString('apply_auth_sync_lines "$auth_lines"', $wrapperSource);
    }

    public function testWrapperKeepsLegacyAuthPullAsFallbackWhenBundleAuthCannotBeUsed(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('sync_auth_with_api "pull" || true', $wrapperSource);
        self::assertStringContainsString('if [[ "$STARTUP_BUNDLE_SYNC_STATUS" == "endpoint-missing" ]]; then', $wrapperSource);
        self::assertStringContainsString('elif [[ "$STARTUP_BUNDLE_SYNC_STATUS" != "offline" ]]; then', $wrapperSource);
    }
}
