<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAgentsUiWiringTest extends TestCase
{
    public function testAdminAgentsSettingsPanelContainsInlineEditorIds(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-panel="agents"', $html);
        $this->assertStringContainsString('id="agentsPreview"', $html);
        $this->assertStringContainsString('id="agentsEditorInline"', $html);
        $this->assertStringContainsString('id="agentsEditToggle"', $html);
        $this->assertStringContainsString('id="agentsSaveInline"', $html);
    }

    public function testAdminConfigBuilderAssetsAreCacheBusted(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('/admin/assets/config.js?v=', $html);
    }

    public function testQuickInsecureHostsStylesIncludeOnlineSubline(): void
    {
        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);

        $this->assertStringContainsString('.quick-hosts-sub', $css);
    }

    public function testQuickInsecureHostsToggleUsesServerActiveFlag(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('target?.active === true', $js);
        $this->assertStringContainsString('typeof host?.active ===', $js);
    }
}
