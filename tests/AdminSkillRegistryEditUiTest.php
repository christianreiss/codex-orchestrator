<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSkillRegistryEditUiTest extends TestCase
{
    public function testSkillRegistryKeepsActionsVisibleAndNavigatesToDedicatedWorkspace(): void
    {
        // SvelteKit: the skills table lives at frontend/src/routes/authoring/+page.svelte
        $page = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/+page.svelte');
        $this->assertIsString($page);

        // Actions column header
        $this->assertStringContainsString('Actions', $page);
        // New-skill trigger
        $this->assertStringContainsString('New skill', $page);
        // "Open" button navigates to the dedicated skill detail workspace
        $this->assertStringContainsString('Open', $page);
        // Link to the dedicated /authoring/skills/:slug route
        $this->assertStringContainsString('/authoring/skills/', $page);
        // Delete skill flow is present
        $this->assertStringContainsString('Delete skill', $page);
        $this->assertStringContainsString('deleteSkill', $page);
    }

    public function testDedicatedSkillWorkspaceMarkupExists(): void
    {
        // SvelteKit: the per-skill editor lives at
        // frontend/src/routes/authoring/skills/[slug]/+page.svelte
        $page = file_get_contents(
            __DIR__ . '/../frontend/src/routes/authoring/skills/[slug]/+page.svelte'
        );
        $this->assertIsString($page);

        // The page exists and contains the skill editor (manifest textarea)
        $this->assertStringContainsString('manifest', $page);
        // AI-managed (managed) skill detection
        $this->assertStringContainsString('isManaged', $page);
        // Assist AI dialog is present
        $this->assertStringContainsString('assistOpen', $page);
        $this->assertStringContainsString('Skill assistant', $page);
        // Changed fields tracked (applied manifest from assistant)
        $this->assertStringContainsString('applyAssistManifest', $page);
        // Delete confirm dialog
        $this->assertStringContainsString('deleteOpen', $page);
    }

    public function testDashboardJsRoutesSkillPagesAndLocksAiManagedFields(): void
    {
        // SvelteKit: routing is file-based. Managed fields are locked in the
        // [slug] page via the isManaged derived state.
        $page = file_get_contents(
            __DIR__ . '/../frontend/src/routes/authoring/skills/[slug]/+page.svelte'
        );
        $this->assertIsString($page);

        // Managed flag disables editing
        $this->assertStringContainsString('isManaged', $page);
        $this->assertStringContainsString('disabled={isManaged}', $page);
        $this->assertStringContainsString('readonly={isManaged}', $page);

        // Navigation from detail back to list uses goto / SvelteKit's base path
        $this->assertStringContainsString('goto', $page);
        $this->assertStringContainsString('/authoring', $page);

        // History (URL) reflects the current skill slug
        $slug = file_get_contents(__DIR__ . '/../frontend/src/routes/authoring/+page.svelte');
        $this->assertIsString($slug);
        $this->assertStringContainsString("encodeURIComponent(row.slug)", $slug);

        // API module wires the skills routes
        $api = file_get_contents(__DIR__ . '/../frontend/src/lib/api/skills.ts');
        $this->assertIsString($api);
        $this->assertStringContainsString('/admin/skills', $api);
    }
}
