<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSkillRegistryEditUiTest extends TestCase
{
    public function testSkillRegistryKeepsActionsVisibleAndNavigatesToDedicatedWorkspace(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('<th>Actions</th>', $html);
        $this->assertStringContainsString('id="newSkillBtn"', $html);

        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);
        $this->assertStringContainsString('#skills {', $css);
        $this->assertStringContainsString('#skills td[data-label="Description"] {', $css);
        $this->assertStringContainsString('#skills td[data-label="Actions"] {', $css);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('class="ghost tiny-btn skill-open"', $js);
        $this->assertStringContainsString('openSkillDetail(slug);', $js);
        $this->assertStringContainsString("navigateAdminShortcut(target);", $js);
        $this->assertStringContainsString('Delete skill "${slug}"? Hosts remove it on next sync.', $js);
    }

    public function testDedicatedSkillWorkspaceMarkupExists(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-panel="skill-detail"', $html);
        $this->assertStringContainsString('id="skillDetailPanel"', $html);
        $this->assertStringContainsString('id="skillConversation"', $html);
        $this->assertStringContainsString('id="skillAssistInput"', $html);
        $this->assertStringContainsString('id="skillAssistSend"', $html);
        $this->assertStringContainsString('id="skillChangedFields"', $html);
        $this->assertStringContainsString('data-skill-unlock="display_name"', $html);
        $this->assertStringContainsString('data-skill-unlock="steps"', $html);
        $this->assertStringNotContainsString('id="skillModal"', $html);

        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);
        $this->assertStringContainsString('.skill-detail-layout {', $css);
        $this->assertStringContainsString('.skill-conversation {', $css);
        $this->assertStringContainsString('.skill-managed-field.is-locked textarea,', $css);
        $this->assertStringContainsString('.skill-field-edit[aria-pressed="true"] {', $css);
    }

    public function testDashboardJsRoutesSkillPagesAndLocksAiManagedFields(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("return { panel: 'skill-detail', sub: seg2 };", $js);
        $this->assertStringContainsString("window.__loadSkillDetailByRoute = loadSkillDetailByRoute;", $js);
        $this->assertStringContainsString("setActiveLinks('.settings-tab', 'skills');", $js);
        $this->assertStringContainsString('input.readOnly = !unlocked;', $js);
        $this->assertStringContainsString("skillTagsInput.disabled = !tagsUnlocked;", $js);
        $this->assertStringContainsString("btn.textContent = unlocked ? 'Editing' : 'Edit';", $js);
        $this->assertStringContainsString('history.replaceState({}, \'\', skillDetailPath(slug));', $js);
    }
}
