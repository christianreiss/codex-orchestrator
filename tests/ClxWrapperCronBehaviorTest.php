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

    public function testCronParsesAndActsOnWrapperUpdateBlock(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/04-update-50-cron.sh');
        self::assertIsString($fragment);

        self::assertStringContainsString('mapfile -t _fields', $fragment);
        self::assertStringContainsString('wrapper_action="${_fields[1]:-}"', $fragment);
        self::assertStringNotContainsString('IFS=$\'\\n\' read -r action wrapper_action', $fragment);
        self::assertStringContainsString('if [[ "$wrapper_action" == "update" ]]; then', $fragment);
        self::assertStringContainsString('cron_perform_wrapper_self_update "$wrapper_target_version" "$wrapper_target_sha" "$wrapper_target_url"', $fragment);
        self::assertStringContainsString('exec env CLX_WRAPPER_RESTARTED=1 "$clx_real" --cron', $fragment);
        self::assertStringContainsString('/wrapper/download?engine=claude', $fragment);
    }

    public function testCronReportKeepsClaudeEngineContext(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/04-update-50-cron.sh');
        self::assertIsString($fragment);

        self::assertGreaterThanOrEqual(2, substr_count($fragment, '--arg engine "claude"'));
        self::assertGreaterThanOrEqual(
            2,
            substr_count($fragment, '{client_version: $client_version, wrapper_version: $wrapper_version, engine: $engine}')
        );
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
