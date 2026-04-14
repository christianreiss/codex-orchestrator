<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperCronBehaviorTest extends TestCase
{
    public function testCronFragmentExposesInstallRemoveAndAutoUpdate(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/04-update-50-cron.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('install_cron_job()', $fragment);
        self::assertStringContainsString('remove_cron_job()', $fragment);
        self::assertStringContainsString('cron_auto_update()', $fragment);
    }

    public function testCronAutoUpdatePingsCheckEndpointWithEngineClaude(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/04-update-50-cron.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('/cron/check', $fragment);
        // jq builds the JSON payload with --arg engine "claude".
        self::assertStringContainsString('--arg engine "claude"', $fragment);
        self::assertStringContainsString('engine: $engine', $fragment);
    }

    public function testWrapperDispatchWiresCronSubcommands(): void
    {
        $wrapper = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapper);

        self::assertStringContainsString('--cron)', $wrapper);
        self::assertStringContainsString('install_cron_job', $wrapper);
        self::assertStringContainsString('remove_cron_job', $wrapper);
        self::assertStringContainsString('cron_auto_update', $wrapper);
    }
}
