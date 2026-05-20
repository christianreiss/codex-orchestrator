<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAgentsUiWiringTest extends TestCase
{
    /**
     * SvelteKit uses file-based routing. Verify that the authoring section
     * has separate route pages for agents and memories, and a shared layout,
     * which replaces the old panel-set / data-settings-panel DOM structure.
     */
    public function testAdminSettingsPanelsStayInsideSettingsPanelSet(): void
    {
        $layout   = __DIR__ . '/../frontend/src/routes/authoring/+layout.svelte';
        $agents   = __DIR__ . '/../frontend/src/routes/authoring/agents/+page.svelte';
        $memories = __DIR__ . '/../frontend/src/routes/authoring/memories/+page.svelte';

        $this->assertFileExists($layout,   'Authoring layout must exist.');
        $this->assertFileExists($agents,   'Agents route page must exist.');
        $this->assertFileExists($memories, 'Memories route page must exist.');

        $layoutSrc = file_get_contents($layout);
        $this->assertIsString($layoutSrc);
        // Layout should expose navigation tabs for agents and memories.
        $this->assertStringContainsString('/authoring/agents', $layoutSrc,
            'Layout must contain a link to the agents section.');
        $this->assertStringContainsString('/authoring/memories', $layoutSrc,
            'Layout must contain a link to the memories section.');
    }

    public function testAdminMemoriesSettingsPanelContainsSearchControls(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/memories/+page.svelte');
        $this->assertIsString($src);

        // Search / filter controls must be present in the component source.
        $this->assertStringContainsString('bind:value={search}', $src,
            'Memories page must have a text search binding.');
        $this->assertStringContainsString('hostFilter', $src,
            'Memories page must have a host filter.');
        $this->assertStringContainsString('Table.Root', $src,
            'Memories page must render a data table.');
        $this->assertStringContainsString('memoriesApi.delete', $src,
            'Memories page must wire up the delete mutation via memoriesApi.delete.');
    }

    public function testAdminMemoriesDeleteUsesDeleteVerb(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/lib/api/memories.ts');
        $this->assertIsString($src);

        // The API client wraps fetch; verify the memories delete call goes to the right path
        // using the typed `api.delete` helper (which sends method: DELETE under the hood).
        $this->assertStringContainsString(
            'api.delete<{ deleted: number | string }>(`/admin/mcp/memories/${encodeURIComponent(String(recordId))}`)' ,
            $src
        );
        // Must NOT pass the verb as a plain string argument (old-style call).
        $this->assertStringNotContainsString(
            "api(`/admin/mcp/memories/\${encodeURIComponent(recordId)}`, 'DELETE')",
            $src
        );
    }

    public function testAdminAgentsSettingsPanelContainsTwoTabWorkspace(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/agents/+page.svelte');
        $this->assertIsString($src);

        // Inline editor (Textarea) + version history side panel.
        $this->assertStringContainsString('Textarea', $src,
            'Agents page must include an inline editor (Textarea).');
        $this->assertStringContainsString('Version history', $src,
            'Agents page must include a version history panel.');
        $this->assertStringContainsString('saveMutation', $src,
            'Agents page must wire a save mutation.');
        $this->assertStringContainsString('revertMutation', $src,
            'Agents page must wire a revert mutation.');

        // Removed elements that must NOT be present.
        $this->assertStringNotContainsString('agentsEditToggle', $src);
        $this->assertStringNotContainsString('agentsBackupLimitInput', $src);
        $this->assertStringNotContainsString('agentsBackupLimitSave', $src);
        $this->assertStringNotContainsString('agentsViewModal', $src);
        $this->assertStringNotContainsString('agentsDeleteModal', $src);
        $this->assertStringNotContainsString('agentsRestoreModal', $src);
    }

    public function testAdminAgentsPreviewRemainsPlainTextUntilClicked(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/agents/+page.svelte');
        $this->assertIsString($src);

        // The editor textarea opens when the user interacts with the content area.
        $this->assertStringContainsString('Textarea', $src,
            'Agents page must contain a Textarea editor element.');
        // Version preview is loaded via a mutation (click-triggered async load).
        $this->assertStringContainsString('versionQuery', $src,
            'Agents page must load version details on demand.');
        $this->assertStringContainsString('loadVersion', $src,
            'Agents page must have a loadVersion function.');
        $this->assertStringContainsString('viewingVersion', $src,
            'Agents page must track which version is being previewed.');
    }

    public function testAdminAgentsSaveOnlyAppearsForUnsavedEditsAndUsesStoreEndpoint(): void
    {
        $apiSrc  = file_get_contents(__DIR__ . '/../frontend/src/lib/api/agents.ts');
        $pageSrc = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/agents/+page.svelte');
        $this->assertIsString($apiSrc);
        $this->assertIsString($pageSrc);

        // API module must call the /admin/agents/store endpoint.
        $this->assertStringContainsString('"/admin/agents/store"', $apiSrc,
            'Agents API must use the /admin/agents/store endpoint.');

        // Page must wire a save mutation and reflect status back to the user.
        $this->assertStringContainsString('saveMutation', $pageSrc,
            'Agents page must have a saveMutation.');
        $this->assertStringContainsString('"No changes to save"', $pageSrc,
            "Agents page must show 'No changes to save' when the content is unchanged.");

        // Old-style inline endpoints must not be referenced from the page.
        $this->assertStringNotContainsString("'/admin/agents/serve'", $pageSrc);
        $this->assertStringNotContainsString("'/admin/agents/retention'", $pageSrc);
    }

    public function testAdminAgentsBackupsOnlyWireRestoreAndDelete(): void
    {
        $apiSrc  = file_get_contents(__DIR__ . '/../frontend/src/lib/api/agents.ts');
        $pageSrc = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/agents/+page.svelte');
        $this->assertIsString($apiSrc);
        $this->assertIsString($pageSrc);

        // API must expose revert (restore) and deleteVersion.
        $this->assertStringContainsString('"/admin/agents/revert"', $apiSrc,
            'Agents API must include a revert (restore) call.');
        $this->assertStringContainsString('api.delete(`/admin/agents/versions/${id}`)', $apiSrc,
            'Agents API must delete specific versions via DELETE.');

        // Page must wire the revert mutation.
        $this->assertStringContainsString('revertMutation', $pageSrc,
            'Agents page must wire a revertMutation for restoring backups.');

        // Old separate view/restore/delete modals must be gone.
        $this->assertStringNotContainsString('data-action="agents-view"', $pageSrc);
        $this->assertStringNotContainsString('Publish latest', $pageSrc);
    }

    public function testAdminConfigBuilderAssetsAreCacheBusted(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        // SvelteKit produces content-hashed immutable assets.
        // The entry JS file names contain a hash (format: <name>.<hash>.js).
        $this->assertMatchesRegularExpression(
            '#/admin/_app/immutable/entry/[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+\.js#',
            $html,
            'index.html must reference content-hashed SvelteKit entry JS assets.'
        );
    }

    public function testAdminConfigBuilderIncludesCurrentFeatureSwitches(): void
    {
        $src = file_get_contents(__DIR__ . '/../frontend/src/routes/settings/+page.svelte');
        $this->assertIsString($src);

        // The settings page must import and render all core settings sections.
        $this->assertStringContainsString('ApiStateSection', $src,
            'Settings page must include ApiStateSection.');
        $this->assertStringContainsString('ClaudeEngineSection', $src,
            'Settings page must include ClaudeEngineSection.');
        $this->assertStringContainsString('AutoUpdateSection', $src,
            'Settings page must include AutoUpdateSection.');
        $this->assertStringContainsString('QuotasSection', $src,
            'Settings page must include QuotasSection.');
        $this->assertStringContainsString('LogRetentionSection', $src,
            'Settings page must include LogRetentionSection.');
        $this->assertStringContainsString('ScalingSection', $src,
            'Settings page must include ScalingSection.');
        $this->assertStringContainsString('InsecureApprovalSection', $src,
            'Settings page must include InsecureApprovalSection.');
        $this->assertStringContainsString('CodexVersionSection', $src,
            'Settings page must include CodexVersionSection.');
    }
}
