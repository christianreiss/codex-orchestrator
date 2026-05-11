<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperAuthUploadCommandTest extends TestCase
{
    public function testWrapperDefinesAuthUploadCommandAndClaudeCredentialExtraction(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapperSource);

        self::assertStringContainsString('clx auth-upload', $wrapperSource);
        self::assertStringContainsString('clx_auth_upload_command()', $wrapperSource);
        self::assertStringContainsString('.auths["api.anthropic.com"].token', $wrapperSource);
        self::assertStringContainsString('.claudeAiOauth.accessToken', $wrapperSource);
        self::assertStringContainsString('--arg engine "claude"', $wrapperSource);
        self::assertStringContainsString("Run 'claude login' first, then retry 'clx auth-upload'.", $wrapperSource);
    }
}
