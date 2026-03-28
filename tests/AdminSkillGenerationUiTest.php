<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSkillGenerationUiTest extends TestCase
{
    public function testAdminSkillGenerateRouteAndControllerMethodExist(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);
        self::assertStringContainsString("#^/admin/skills/generate$#", $routerSource);

        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminConfigController.php');
        self::assertIsString($controllerSource);
        self::assertStringContainsString('public function skillGenerate(array $payload): void', $controllerSource);
        self::assertStringContainsString('$this->skillDraftService->generate', $controllerSource);
    }

    public function testSkillModalExposesPromptDrivenDraftControls(): void
    {
        $html = @file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);
        self::assertStringContainsString('id="skillPromptField"', $html);
        self::assertStringContainsString('id="skillPrompt"', $html);
        self::assertStringContainsString('id="skillGenerate"', $html);
        self::assertStringContainsString('Runner-backed draft only. Nothing is saved until you click <strong>Save</strong>.', $html);

        $js = @file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);
        self::assertStringContainsString("const skillPromptField = document.getElementById('skillPromptField');", $js);
        self::assertStringContainsString("const skillGenerate = document.getElementById('skillGenerate');", $js);
        self::assertStringContainsString("skillPromptField.hidden = isEdit;", $js);
        self::assertStringContainsString("async function generateSkillDraft()", $js);
        self::assertStringContainsString("api('/admin/skills/generate'", $js);
        self::assertStringContainsString("applyGeneratedSkillDraft(resp?.data || {});", $js);
        self::assertStringContainsString("AI draft generation is only available for new skills.", $js);
        self::assertStringContainsString("Draft ready. Review and save when it looks right.", $js);
    }
}
