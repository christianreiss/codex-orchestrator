<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperAuthUploadCommandTest extends TestCase
{
    public function testWrapperDefinesAuthUploadCommand(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('CODEX_AUTH_UPLOAD_ONLY=0', $wrapperSource);
        self::assertStringContainsString('auth-upload)', $wrapperSource);
        self::assertStringContainsString('auth_upload_with_api()', $wrapperSource);
        self::assertStringContainsString('"command": "store"', $wrapperSource);
        self::assertStringContainsString('normalize_auth_json_file "$auth_path"', $wrapperSource);
        self::assertStringContainsString('Run \'codex login\' first, then retry \'cdx auth-upload\'.', $wrapperSource);
    }

    public function testAuthUploadExitsBeforeNormalStartupSync(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $authUploadPos = strpos($wrapperSource, 'elif ((CODEX_AUTH_UPLOAD_ONLY)); then');
        $startupSyncPos = strpos($wrapperSource, 'cleanup_legacy_prompt_state || true');

        self::assertNotFalse($authUploadPos, 'Expected auth-upload early exit path');
        self::assertNotFalse($startupSyncPos, 'Expected normal startup sync path');
        self::assertLessThan($startupSyncPos, $authUploadPos, 'auth-upload should not run normal startup sync before uploading');
    }
}
