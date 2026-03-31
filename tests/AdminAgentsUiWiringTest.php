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

    public function testAdminMemoriesDeleteUsesDeleteVerb(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('api(`/admin/mcp/memories/${encodeURIComponent(recordId)}`, { method: \'DELETE\' })', $js);
        $this->assertStringNotContainsString('api(`/admin/mcp/memories/${encodeURIComponent(recordId)}`, \'DELETE\')', $js);
    }

    public function testAdminAgentsSettingsPanelContainsTwoTabWorkspace(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-panel="agents"', $html);
        $this->assertStringContainsString('data-agents-tab="content"', $html);
        $this->assertStringContainsString('data-agents-tab="backups"', $html);
        $this->assertStringContainsString('data-agents-tab-panel="content"', $html);
        $this->assertStringContainsString('data-agents-tab-panel="backups"', $html);
        $this->assertStringContainsString('id="agentsPreview"', $html);
        $this->assertStringContainsString('id="agentsEditorInline"', $html);
        $this->assertStringContainsString('id="agentsSaveInline"', $html);
        $this->assertStringContainsString('id="agentsBackupsMeta"', $html);
        $this->assertStringContainsString('id="agentsVersions"', $html);

        $this->assertStringNotContainsString('id="agentsEditToggle"', $html);
        $this->assertStringNotContainsString('id="agentsBackupLimitInput"', $html);
        $this->assertStringNotContainsString('id="agentsBackupLimitSave"', $html);
        $this->assertStringNotContainsString('id="agentsServeLatest"', $html);
        $this->assertStringNotContainsString('id="agentsEmptyEdit"', $html);
        $this->assertStringNotContainsString('id="agentsViewModal"', $html);
        $this->assertStringNotContainsString('id="agentsDeleteModal"', $html);
        $this->assertStringNotContainsString('id="agentsRestoreModal"', $html);
    }

    public function testAdminAgentsPreviewRemainsPlainTextUntilClicked(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('class="agents-preview"', $html);
        $this->assertStringContainsString('aria-label="Click or press Enter to edit AGENTS.md"', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('agentsPreview.addEventListener(\'click\', () => {', $js);
        $this->assertStringContainsString('openAgentsEditor();', $js);
        $this->assertStringContainsString('agentsEditorInline.addEventListener(\'blur\', () => {', $js);
        $this->assertStringContainsString('maybeCloseAgentsEditorOnBlur()', $js);
    }

    public function testAdminAgentsSaveOnlyAppearsForUnsavedEditsAndUsesStoreEndpoint(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('function agentsHasUnsavedChanges()', $js);
        $this->assertStringContainsString('agentsSaveInline.hidden = !dirty;', $js);
        $this->assertStringContainsString("setAgentsStatusMessage('Saving AGENTS.md…', null);", $js);
        $this->assertStringContainsString("api('/admin/agents/store', {", $js);
        $this->assertStringContainsString("const msg = result?.status === 'unchanged' ? 'No changes to save' : 'Saved AGENTS.md';", $js);

        $this->assertStringNotContainsString("api('/admin/agents/serve'", $js);
        $this->assertStringNotContainsString("api('/admin/agents/retention'", $js);
        $this->assertStringNotContainsString('⌘S', $js);
    }

    public function testAdminAgentsBackupsOnlyWireRestoreAndDelete(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('data-action="agents-restore"', $js);
        $this->assertStringContainsString('data-action="agents-delete"', $js);
        $this->assertStringContainsString("api('/admin/agents/revert', {", $js);
        $this->assertStringContainsString('await api(`/admin/agents/versions/${id}`, { method: \'DELETE\' });', $js);
        $this->assertStringContainsString("json: { selection: 'global' },", $js);

        $this->assertStringNotContainsString('data-action="agents-view"', $js);
        $this->assertStringNotContainsString('api(\'/admin/agents/versions/${id}\')', $js);
        $this->assertStringNotContainsString('Publish latest', $js);
    }

    public function testAdminConfigBuilderAssetsAreCacheBusted(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('/admin/assets/config.js?v=', $html);
    }

    public function testAdminConfigBuilderIncludesCurrentFeatureSwitches(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="personalityInput"', $html);
        $this->assertStringContainsString('id="featureFastMode"', $html);
        $this->assertStringContainsString('id="featureUnifiedExec"', $html);
        $this->assertStringContainsString('id="featureWebSearch"', $html);
        $this->assertStringContainsString('id="featureVoiceTranscription"', $html);
        $this->assertStringContainsString('id="featureApps"', $html);
        $this->assertStringContainsString('id="featureGuardianApproval"', $html);
        $this->assertStringContainsString('id="featureJsRepl"', $html);
    }
}
