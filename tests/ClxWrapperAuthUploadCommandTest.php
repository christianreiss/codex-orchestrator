<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperAuthUploadCommandTest extends TestCase
{
    public function testWrapperDefinesAuthUploadCommandAndClaudeCredentialExtraction(): void
    {
        // auth-upload subcommand is dispatched in cmd/clx/main.go
        $mainSource = file_get_contents(__DIR__ . '/../wrappers/clx/cmd/clx/main.go');
        self::assertIsString($mainSource);

        self::assertStringContainsString('auth-upload', $mainSource);
        self::assertStringContainsString('cmdAuthUpload', $mainSource);

        // The Go implementation reads credentials via claude.ReadAuth() and
        // stores them via client.AuthStore() with engine="claude"
        self::assertStringContainsString('claude.ReadAuth()', $mainSource);
        self::assertStringContainsString('client.AuthStore(', $mainSource);

        // Credential extraction lives in preexec.go and freshness.go
        $preexecSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/preexec.go');
        self::assertIsString($preexecSource);

        // Both credential shapes the bash wrapper handled are present
        self::assertStringContainsString('auths', $preexecSource);
        self::assertStringContainsString('api.anthropic.com', $preexecSource);
        self::assertStringContainsString('claudeAiOauth', $preexecSource);
        self::assertStringContainsString('AccessToken', $preexecSource);

        // Engine is "claude" in auth POST body (orchestrator/auth.go)
        $authSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/auth.go');
        self::assertIsString($authSource);
        self::assertStringContainsString('"engine"', $authSource);
        self::assertStringContainsString('"claude"', $authSource);

        // Freshness helper also documents both credential shapes
        $freshnessSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/freshness.go');
        self::assertIsString($freshnessSource);
        self::assertStringContainsString('api.anthropic.com', $freshnessSource);
        self::assertStringContainsString('claudeAiOauth', $freshnessSource);
        self::assertStringContainsString('accessToken', $freshnessSource);

        // The auth-upload subcommand must not reference Codex reasoning-effort
        self::assertStringNotContainsString('CLAUDE_REASONING_EFFORT', $mainSource);
    }
}
