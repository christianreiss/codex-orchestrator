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
    }

    public function testSkillEditModeLocksSlugAndKeepsUpdateActionExplicit(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString("let skillModalMode = 'new';", $js);
        $this->assertStringContainsString("let skillEditingSlug = '';", $js);
        $this->assertStringContainsString("skillSave.textContent = isEdit ? 'Save changes' : 'Save';", $js);
        $this->assertStringContainsString('skillSlug.readOnly = isEdit;', $js);
        $this->assertStringContainsString('if (isEdit && slug !== skillEditingSlug)', $js);
    }
}

