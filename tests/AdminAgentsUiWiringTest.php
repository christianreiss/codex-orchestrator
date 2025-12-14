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

    public function testAdminMemoriesSettingsPanelHasStableId(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $dom = new DOMDocument();
        libxml_use_internal_errors(true);
        $dom->loadHTML($html);
        libxml_clear_errors();

        $xpath = new DOMXPath($dom);

        $memoriesPanels = $xpath->query('//*[@data-settings-panel="memories"]');
        $this->assertNotFalse($memoriesPanels);
        $this->assertSame(1, $memoriesPanels->length, 'Expected exactly one settings panel for memories.');

        $memoriesPanel = $memoriesPanels->item(0);
        $this->assertNotNull($memoriesPanel);
        $this->assertSame('memories-panel', $memoriesPanel->attributes?->getNamedItem('id')?->nodeValue ?? '', 'Memories panel must keep id="memories-panel" for the JS loader.');

        $memoriesIdMatches = $xpath->query('//*[@id="memories-panel"]');
        $this->assertNotFalse($memoriesIdMatches);
        $this->assertSame(1, $memoriesIdMatches->length, 'Expected exactly one element with id="memories-panel".');
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
