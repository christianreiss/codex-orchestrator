<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSyncConfigPrecedenceTest extends TestCase
{
    public function testWrapperPrefersBakedSyncConfigOverCliLoginCredentials(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $start = strpos($wrapperSource, 'has_baked_sync_config() {');
        self::assertNotFalse($start, 'Expected has_baked_sync_config helper in wrapper');

        $end = strpos($wrapperSource, 'detect_codex_asset_name()', $start);
        self::assertNotFalse($end, 'Expected detect_codex_asset_name after sync-config helpers');

        $segment = substr($wrapperSource, $start, $end - $start);
        self::assertStringContainsString('if has_baked_sync_config; then', $segment);
        self::assertStringContainsString('elif [[ -f "$cred_file" ]]; then', $segment);
        self::assertStringContainsString('config (baked)', $segment);
        self::assertStringContainsString('config (credentials.env)', $segment);
        self::assertStringContainsString('local base_placeholder="__CODEX_SYNC_BASE""_URL__"', $segment);
        self::assertStringContainsString('local key_placeholder="__CODEX_SYNC_API""_KEY__"', $segment);

        $bakedBranchPos = strpos($segment, 'if has_baked_sync_config; then');
        $credentialsSourcePos = strpos($segment, 'source "$cred_file"');
        self::assertNotFalse($bakedBranchPos);
        self::assertNotFalse($credentialsSourcePos);
        self::assertLessThan($credentialsSourcePos, $bakedBranchPos, 'Baked sync config must win over credentials.env');
    }
}
