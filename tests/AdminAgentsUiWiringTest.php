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

    public function testAdminAgentsSettingsPanelContainsInlineEditorIds(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-settings-panel="agents"', $html);
        $this->assertStringContainsString('id="agentsPreview"', $html);
        $this->assertStringContainsString('id="agentsEditorInline"', $html);
        $this->assertStringContainsString('id="agentsEditToggle"', $html);
        $this->assertStringContainsString('id="agentsSaveInline"', $html);
        $this->assertStringContainsString('id="agentsBackupLimitInput"', $html);
        $this->assertStringContainsString('id="agentsBackupLimitSave"', $html);
        $this->assertStringContainsString('id="agentsBackupLimitMeta"', $html);
        $this->assertStringContainsString('id="agentsServeLatest"', $html);
        $this->assertStringContainsString('id="agentsVersions"', $html);
        $this->assertStringContainsString('id="agentsViewModal"', $html);
        $this->assertStringContainsString('id="agentsViewContent"', $html);
    }

    public function testAdminAgentsDeleteModalIncludesReassignmentControls(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="agentsDeleteModal"', $html);
        $this->assertStringContainsString('id="agentsDeleteSelect"', $html);
        $this->assertStringContainsString('id="agentsDeleteHosts"', $html);
        $this->assertStringContainsString('id="agentsDeleteConfirm"', $html);
    }

    public function testAdminAgentsHistoryActionsAreWiredForViewAndRestore(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("data-action=\"agents-view\"", $js);
        $this->assertStringContainsString("data-action=\"agents-restore\"", $js);
        $this->assertStringContainsString('api(`/admin/agents/versions/', $js);
        $this->assertStringContainsString("api('/admin/agents/revert'", $js);
        $this->assertStringNotContainsString("data-action=\"agents-serve\"", $js);
    }

    public function testAdminAgentsInlineSaveGuardsDuplicateClicksAndExplainsPinnedDrafts(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('let agentsSaveInFlight = false;', $js);
        $this->assertStringContainsString('if (!agentsEditorInline || !agentsSaveInline || agentsSaveInFlight) return;', $js);
        $this->assertStringContainsString('as latest draft v', $js);
        $this->assertStringContainsString('Use Publish latest to roll it out.', $js);
        $this->assertStringContainsString('pruned', $js);
    }

    public function testAdminAgentsDraftBannerTracksUnsavedChangesOnly(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('Unsaved changes.', $html);
        $this->assertStringContainsString('Save or cancel before leaving the editor.', $html);
        $this->assertStringNotContainsString('id="agentsDraftPublish"', $html);
        $this->assertStringNotContainsString('Publish now', $html);
        $this->assertStringNotContainsString('Save now', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('function setAgentsDirty(isDirty)', $js);
        $this->assertStringContainsString('function normalizeAgentsEditorText(value)', $js);
        $this->assertStringContainsString('function agentsHasUnsavedChanges()', $js);
        $this->assertStringContainsString('function syncAgentsDraftBanner()', $js);
        $this->assertStringContainsString('function normalizeAgentsEditorState(options = {})', $js);
        $this->assertStringNotContainsString("agentsDraftPublish.addEventListener('click', () => saveAgentsInline());", $js);
        $this->assertStringContainsString("agentsServeLatest.textContent = pinnedDraft ? 'Publish latest draft' : 'Publish latest';", $js);
    }

    public function testAdminAgentsCancelDiscardsInlineEditsImmediately(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('if (!on) {', $js);
        $this->assertStringContainsString('_applyAgentsEditingState(false);', $js);
        $this->assertStringContainsString("setAgentsStatusMessage('', null);", $js);
        $this->assertStringNotContainsString("showConfirmModal(\n            'Discard changes?'", $js);
    }

    public function testAdminAgentsDeleteGuardsDuplicateClicks(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('let agentsDeleteInFlight = false;', $js);
    }

    public function testAdminAgentsBackupRetentionControlIsWired(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("const agentsBackupLimitInput = document.getElementById('agentsBackupLimitInput');", $js);
        $this->assertStringContainsString("const agentsBackupLimitSave = document.getElementById('agentsBackupLimitSave');", $js);
        $this->assertStringContainsString("const agentsBackupLimitMeta = document.getElementById('agentsBackupLimitMeta');", $js);
        $this->assertStringContainsString("api('/admin/agents/retention'", $js);
        $this->assertStringContainsString('function describeAgentsBackupLimit(limit)', $js);
        $this->assertStringContainsString('Saved backup retention', $js);
        $this->assertStringContainsString('Saved retention limit and pruned', $js);
    }

    public function testAdminAgentsPreviewUsesCorrectCssClass(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('class="agents-preview"', $html);
        $this->assertStringNotContainsString('class="code-block"', $html);
    }

    public function testAdminAgentsEmptyStateExists(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="agentsEmptyState"', $html);
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
        $this->assertStringContainsString('id="featureTuiAppServer"', $html);
        $this->assertStringNotContainsString('id="featureBubblewrapSandbox"', $html);
        $this->assertStringContainsString('id="featurePreventIdleSleep"', $html);
        $this->assertStringContainsString('id="featureMultiAgent"', $html);
    }

    public function testAdminConfigBuilderApprovalPolicyOmitsDeprecatedOnFailure(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="approvalPolicyInput"', $html);
        $this->assertStringNotContainsString('<option value="on-failure">on-failure</option>', $html);
        $this->assertStringContainsString('auto-migrated to <code>on-request</code>', $html);
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
        $this->assertStringContainsString('id="logRetentionDaysGraphStatsLabel"', $html);
        $this->assertStringContainsString('id="logRetentionDaysGraphStatsSlider"', $html);
        $this->assertStringContainsString('Set-aside Graph Stats', $html);
    }

    public function testSettingsTogglesStartNeutralUntilLiveStateLoads(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="scalingBadge">Loading…</span>', $html);
        $this->assertStringContainsString('id="scalingLabel">Loading…</span>', $html);
        $this->assertStringContainsString('id="reverseDnsBadge">Loading…</span>', $html);
        $this->assertStringContainsString('id="reverseDnsLabel">Loading…</span>', $html);
        $this->assertStringContainsString('id="insecureApprovalBadge">Loading…</span>', $html);
        $this->assertStringContainsString('id="insecureApprovalLabel">Loading…</span>', $html);
        $this->assertStringContainsString('id="autoUpdateBadge">Loading…</span>', $html);
        $this->assertStringContainsString('id="autoUpdateLabel">Loading…</span>', $html);
        $this->assertStringContainsString('id="logRetentionLabel">Loading…</span>', $html);
        $this->assertStringContainsString('id="projectsEnabledLabel">Loading…</span>', $html);
    }

    public function testUsageScalingUiUsesConsistentToggleStateAndSeedsDefaultTier(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('function renderBinarySetting({', $js);
        $this->assertStringContainsString('function defaultScalingTier(index = 0) {', $js);
        $this->assertStringContainsString('const DEFAULT_SCALING_TIERS = [', $js);
        $this->assertStringContainsString("{ projected_percent: 80, reasoning_effort: 'high', model: 'gpt-5.4' }", $js);
        $this->assertStringContainsString("{ projected_percent: 85, reasoning_effort: 'medium', model: 'gpt-5.4' }", $js);
        $this->assertStringContainsString("{ projected_percent: 92, reasoning_effort: 'high', model: 'gpt-5.3-codex' }", $js);
        $this->assertStringContainsString("{ projected_percent: 100, reasoning_effort: 'medium', model: 'gpt-5.3-codex' }", $js);
        $this->assertStringNotContainsString("{ value: 'gpt-5.3-codex-spark', label: 'gpt-5.3-codex-spark' }", $js);
        $this->assertStringContainsString('function ensureScalingRulesState(seedTier = false) {', $js);
        $this->assertStringContainsString('function cloneScalingDataState() {', $js);
        $this->assertStringContainsString('ensureScalingRulesState(scalingToggle.checked);', $js);
        $this->assertStringContainsString('const rollbackState = cloneScalingDataState();', $js);
        $this->assertStringContainsString('saveScalingRules({', $js);
        $this->assertStringContainsString("successMessage: scalingToggle.checked ? 'Usage scaling enabled' : 'Usage scaling disabled'", $js);
        $this->assertStringContainsString('scalingData.rules.tiers = defaultScalingTiers();', $js);
        $this->assertStringContainsString('tiers.push(...defaultScalingTiers());', $js);
        $this->assertStringContainsString('Usage scaling is off.', $js);
        $this->assertStringNotContainsString("scalingBadge.textContent = enabled ? 'Active' : 'Disabled';", $js);
    }

    public function testQuickInsecureHostsToggleUsesServerActiveFlag(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('target?.active === true', $js);
        $this->assertStringContainsString('typeof host?.active ===', $js);
    }

    public function testLogRetentionUiWiresGraphStatsSlider(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("const logRetentionDaysGraphStatsSlider = document.getElementById('logRetentionDaysGraphStatsSlider');", $js);
        $this->assertStringContainsString("const logRetentionDaysGraphStatsLabel = document.getElementById('logRetentionDaysGraphStatsLabel');", $js);
        $this->assertStringContainsString("days_graph_stats: logRetentionDaysGraphStats", $js);
        $this->assertStringContainsString("'logRetentionDaysGraphStats'", $js);
        $this->assertStringContainsString("logRetentionDaysGraphStats = clampRetentionDays(currentOverview.log_retention_days_graph_stats);", $js);
    }

    public function testDashboardFooterUsesSingleTextSummaryBar(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="dashboardFooterText"', $html);
        $this->assertStringNotContainsString('id="dashboardFooterFleet"', $html);
        $this->assertStringNotContainsString('id="dashboardFooterSpend"', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString("const dashboardFooterText = document.getElementById('dashboardFooterText');", $js);
        $this->assertStringContainsString('function countHostsActiveToday(hostsList = []) {', $js);
        $this->assertStringContainsString('const activeAt = host?.last_seen || host?.last_refresh || host?.updated_at || null;', $js);
        $this->assertStringContainsString('active today.', $js);
        $this->assertStringContainsString('Codex version <strong>', $js);
        $this->assertStringContainsString('Spend <strong>${formatCurrency(dayCost, planCurrency)}</strong> today', $js);
    }

    public function testAdminCostOverpayMessageRemoved(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        // Overpay note was removed as part of dashboard simplification.
        // Cost data is available via the cost trend chart instead.
        $this->assertStringNotContainsString('Overpaying by', $js);
        $this->assertStringNotContainsString('Wrong way around', $js);
    }

    public function testHostListHealthyPillRequiresNonOutdatedAuth(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("if (host?.auth_outdated) {\n        return { label: 'Outdated auth', tone: 'warn', rank: 1 };\n      }", $js);
        $this->assertStringContainsString("return { label: 'Healthy', tone: 'ok', rank: 0 };", $js);
    }

    public function testUsageWindowBulletMeterMarkupExists(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('class="fill"', $js);
        $this->assertStringContainsString('class="marker"', $js);
        $this->assertStringContainsString('aria-label="${meterLabel}"', $js);
    }

    public function testAdminSeedAuthModalIncludesSeedCommandControls(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="seedCommandBtn"', $html);
        $this->assertStringContainsString('id="seedCommandField"', $html);
        $this->assertStringContainsString('id="seedCommandText"', $html);
        $this->assertStringContainsString('id="seedCommandCopy"', $html);
        $this->assertStringContainsString('id="seedCommandMeta"', $html);
    }
}
