<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSettingsLiveUpdateLogActionsTest extends TestCase
{
    public function testSettingsMutationsLogActionsForWebsocketPush(): void
    {
        $php = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($php);

        $this->assertStringContainsString("'admin.api.state'", $php);
        $this->assertStringContainsString("'admin.cdx_silent'", $php);
        $this->assertStringContainsString("'admin.reverse_dns'", $php);
        $this->assertStringContainsString("'admin.insecure_approval'", $php);
        $this->assertStringContainsString("'admin.codex_version'", $php);
        $this->assertStringContainsString("'admin.quota_mode'", $php);
        $this->assertStringContainsString("'admin.prune_policy'", $php);
    }
}
