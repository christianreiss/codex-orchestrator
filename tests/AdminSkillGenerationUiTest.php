<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSkillGenerationUiTest extends TestCase
{
    public function testAdminSkillWorkspaceRoutesAndAssistEndpointExist(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);
        self::assertStringContainsString("#^/admin/skills/new$#", $routerSource);
        self::assertStringContainsString("#^/admin/skills/([^/]+)$#", $routerSource);
        self::assertStringContainsString("#^/admin/skills/assist$#", $routerSource);
        self::assertStringContainsString("if (isBrowserRequest()) { \$adminPageCtrl->skill(); return; }", $routerSource);

        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminConfigController.php');
        self::assertIsString($controllerSource);
        self::assertStringContainsString('public function skillAssist(array $payload): void', $controllerSource);
        self::assertStringContainsString('$this->skillDraftService->assist', $controllerSource);

        $pageControllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminPageController.php');
        self::assertIsString($pageControllerSource);
        self::assertStringContainsString('public function skill(): void', $pageControllerSource);
    }

    public function testSkillWorkspaceUsesConversationalAssistFlow(): void
    {
        $html = @file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);
        self::assertStringContainsString('Talk with your skill', $html);
        self::assertStringContainsString('id="skillAssistInput"', $html);
        self::assertStringContainsString('id="skillAssistSend"', $html);
        self::assertStringContainsString('Session only. The conversation is not stored;', $html);

        $js = @file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);
        self::assertStringContainsString('async function assistSkillDraft()', $js);
        self::assertStringContainsString("api('/admin/skills/assist'", $js);
        self::assertStringContainsString("skillConversationMessages = [...messages, {", $js);
        self::assertStringContainsString("role: 'assistant',", $js);
        self::assertStringContainsString("if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {", $js);
        self::assertStringContainsString('renderSkillChangedFields();', $js);
    }
}
