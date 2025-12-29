<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAgentsUiWiringTest extends TestCase
{
    public function testAdminSettingsPanelsStayInsideSettingsPanelSet(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $dom = new DOMDocument();
        libxml_use_internal_errors(true);
        $dom->loadHTML($html);
        libxml_clear_errors();

        $xpath = new DOMXPath($dom);

        $settingsPanelSets = $xpath->query('//*[contains(concat(" ", normalize-space(@class), " "), " panel-set ")][@data-panel="settings"]');
        $this->assertNotFalse($settingsPanelSets);
        $this->assertSame(1, $settingsPanelSets->length, 'Expected exactly one settings panel-set container.');

        $settingsPanels = $xpath->query('//*[@data-settings-panel]');
        $this->assertNotFalse($settingsPanels);
        $this->assertGreaterThan(0, $settingsPanels->length, 'Expected at least one settings panel.');

        foreach ($settingsPanels as $panel) {
            $ancestor = $panel->parentNode;
            $insideSettingsPanelSet = false;
            while ($ancestor !== null && $ancestor->nodeType === XML_ELEMENT_NODE) {
                $class = $ancestor->attributes?->getNamedItem('class')?->nodeValue ?? '';
                $dataPanel = $ancestor->attributes?->getNamedItem('data-panel')?->nodeValue ?? '';
                if (str_contains(" {$class} ", ' panel-set ') && strtolower(trim($dataPanel)) === 'settings') {
                    $insideSettingsPanelSet = true;
                    break;
                }
                $ancestor = $ancestor->parentNode;
            }

            $panelName = $panel->attributes?->getNamedItem('data-settings-panel')?->nodeValue ?? '(unknown)';
            $this->assertTrue($insideSettingsPanelSet, "Settings panel '{$panelName}' must be nested under the settings panel-set.");
        }
    }

    public function testAdminMemoriesSettingsPanelContainsSearchControls(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-panel="memories"', $html);
        $this->assertStringContainsString('id="memoriesFilters"', $html);
        $this->assertStringContainsString('id="memoriesQuery"', $html);
        $this->assertStringContainsString('id="memoriesHostFilter"', $html);
        $this->assertStringContainsString('id="memoriesTags"', $html);
        $this->assertStringContainsString('id="memoriesLimit"', $html);
        $this->assertStringContainsString('id="memoriesTableWrap"', $html);
        $this->assertStringContainsString('id="memoriesEmptyState"', $html);
    }

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

    public function testAdminConfigBuilderIncludesExperimentalFeatureSwitches(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="featureBackgroundTerminal"', $html);
        $this->assertStringContainsString('id="featureUnifiedExec"', $html);
        $this->assertStringContainsString('id="featureRmcpClient"', $html);
        $this->assertStringContainsString('id="featureSandboxAssessment"', $html);
        $this->assertStringContainsString('id="featureGhostCommit"', $html);
        $this->assertStringContainsString('id="featureExperimentalWindowsSandbox"', $html);
    }

    public function testQuickInsecureHostsStylesIncludeOnlineSubline(): void
    {
        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);

        $this->assertStringContainsString('.quick-hosts-sub', $css);
    }

    public function testAdminSettingsGeneralIncludesPruneWindowControls(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="pruneWindowLabel"', $html);
        $this->assertStringContainsString('id="pruneWindowSlider"', $html);
    }

    public function testQuickInsecureHostsToggleUsesServerActiveFlag(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('target?.active === true', $js);
        $this->assertStringContainsString('typeof host?.active ===', $js);
    }
}
