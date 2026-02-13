<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSkillRegistryEditUiTest extends TestCase
{
    public function testSkillModalProvidesDedicatedSlugHintContainer(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="skillSlug"', $html);
        $this->assertStringContainsString('id="skillSlugSuggest"', $html);
        $this->assertStringContainsString('id="skillSlugNote"', $html);
        $this->assertStringContainsString('id="skillDelete"', $html);
    }

    public function testSkillRegistryTableKeepsActionsVisibleAndLabeled(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('<th>Actions</th>', $html);

        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);
        $this->assertStringContainsString('.table-wrap,', $css);
        $this->assertStringContainsString('.table-wrapper {', $css);
        $this->assertStringContainsString('.table-wrapper { overflow-x: auto; }', $css);
    }

    public function testSkillEditModeLocksSlugAndKeepsUpdateActionExplicit(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("let skillModalMode = 'new';", $js);
        $this->assertStringContainsString("let skillEditingSlug = '';", $js);
        $this->assertStringContainsString("skillSave.textContent = isEdit ? 'Save changes' : 'Save';", $js);
        $this->assertStringContainsString('skillSlug.readOnly = isEdit;', $js);
        $this->assertStringContainsString('skillDelete.hidden = !isEdit;', $js);
        $this->assertStringContainsString('<div class="table-actions">', $js);
        $this->assertStringContainsString('class="ghost tiny-btn skill-edit"', $js);
        $this->assertStringContainsString('class="ghost tiny-btn danger skill-delete"', $js);
        $this->assertStringContainsString('if (isEdit && slug !== skillEditingSlug)', $js);
        $this->assertStringContainsString('skillDelete.addEventListener(\'click\'', $js);
        $this->assertStringContainsString('deleteSkill(slug, { fromModal: true });', $js);
        $this->assertStringContainsString('Delete skill "${slug}"? Hosts remove it on next sync.', $js);
    }
}
