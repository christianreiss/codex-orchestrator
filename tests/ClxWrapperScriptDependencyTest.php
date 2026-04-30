<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * Ensures the CLX wrapper still carries the core operational helpers required
 * for parity with CDX (auth validation, auth push, startup bundle, SHA256
 * verify, restart-loop guard).
 */
final class ClxWrapperScriptDependencyTest extends TestCase
{
    public function testWrapperExposesValidationAndPushFragments(): void
    {
        $wrapperSource = $this->readWrapper();
        self::assertStringContainsString('validate_auth_json_file()', $wrapperSource, 'Expected auth validation helper from 02-auth-20-validate.sh');
        self::assertStringContainsString('clx_auth_push()', $wrapperSource, 'Expected dedicated auth push helper from 02-auth-30-push.sh');
    }

    public function testWrapperIncludesStartupBundleAndFallback(): void
    {
        $wrapperSource = $this->readWrapper();
        self::assertStringContainsString('clx_startup_bundle_pull()', $wrapperSource);
        self::assertStringContainsString('CLX_USE_STARTUP_BUNDLE', $wrapperSource);
        // The bootstrap orchestrator must still run the per-phase syncs when the bundle is off.
        self::assertStringContainsString('clx_sync_agents', $wrapperSource);
        self::assertStringContainsString('clx_sync_config', $wrapperSource);
    }

    public function testWrapperRequiresSha256VerificationForSelfUpdates(): void
    {
        $wrapperSource = $this->readWrapper();
        self::assertStringContainsString('Wrapper SHA256 mismatch', $wrapperSource);
        self::assertStringContainsString('Refusing to install unverified wrapper', $wrapperSource);
        self::assertStringContainsString('sha256sum', $wrapperSource);
    }

    public function testWrapperHasRestartLoopGuard(): void
    {
        $wrapperSource = $this->readWrapper();
        self::assertStringContainsString('CLAUDE_WRAPPER_RESTART_DEPTH', $wrapperSource);
        self::assertStringContainsString('bailing out to avoid an update loop', $wrapperSource);
    }

    public function testWrapperDependencyCheckIncludesJqAndCurl(): void
    {
        $wrapperSource = $this->readWrapper();
        // jq and curl are hard deps — Claude config + auth sync cannot function without them.
        self::assertStringContainsString('jq', $wrapperSource);
        self::assertStringContainsString('curl', $wrapperSource);
    }

    public function testVersionTokenRegexKeepsHyphenLiteral(): void
    {
        $wrapperSource = $this->readWrapper();

        self::assertStringContainsString('[0-9A-Za-z.+_-]*', $wrapperSource);
        self::assertStringNotContainsString('[0-9A-Za-z\.\-\+_]*', $wrapperSource);
    }

    private function readWrapper(): string
    {
        $path = __DIR__ . '/../bin/clx';
        $source = @file_get_contents($path);
        self::assertIsString($source, 'Expected to be able to read bin/clx');
        return $source;
    }
}
