<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * A CLX host that has no FQDN configured (and no sync URL / API key) must still
 * launch — the wrapper can run against a locally-installed Claude CLI with
 * ANTHROPIC_API_KEY in the env. Verify the sync helpers no-op gracefully in that
 * case rather than erroring out.
 */
final class ClxWrapperFqdnGuardTest extends TestCase
{
    public function testAuthSyncShortCircuitsWithoutSyncConfig(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/02-auth-10-sync.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then', $fragment);
        self::assertStringContainsString('AUTH_PULL_STATUS="skip"', $fragment);
    }

    public function testConfigSyncShortCircuitsWithoutSyncConfig(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-30-config.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('if [[ -z "$CLAUDE_SYNC_BASE_URL" ]] || [[ -z "$CLAUDE_SYNC_API_KEY" ]]; then', $fragment);
    }

    public function testStartupBundleShortCircuitsWithoutSyncConfig(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-40-startup-bundle.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('missing-config', $fragment);
    }
}
