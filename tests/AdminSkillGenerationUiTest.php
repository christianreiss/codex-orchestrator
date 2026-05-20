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
        // SvelteKit: the skill workspace uses an AI assist dialog in the detail page.
        $page = @file_get_contents(
            __DIR__ . '/../frontend/src/routes/authoring/skills/[slug]/+page.svelte'
        );
        self::assertIsString($page);

        // The assist feature is present as a mutation that calls skillsApi.assist
        self::assertStringContainsString('skillsApi.assist', $page);
        // Conversations are sent as a messages array with role/content entries
        self::assertStringContainsString("role: \"user\"", $page);
        self::assertStringContainsString('assistQuestion', $page);
        self::assertStringContainsString('assistResult', $page);
        // The dialog opens from an "Assist (AI)" button
        self::assertStringContainsString('Assist (AI)', $page);

        // The API module wires the POST /admin/skills/assist endpoint
        $api = @file_get_contents(__DIR__ . '/../frontend/src/lib/api/skills.ts');
        self::assertIsString($api);
        self::assertStringContainsString('/admin/skills/assist', $api);
        // Messages array carries role + content
        self::assertStringContainsString('role', $api);
        self::assertStringContainsString('content', $api);
    }
}
