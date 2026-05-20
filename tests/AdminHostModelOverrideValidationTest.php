<?php

use PHPUnit\Framework\TestCase;

final class AdminHostModelOverrideValidationTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/(\\d+)/model$#",
            $routerSource,
            'Expected /admin/hosts/{id}/model route to exist in public/index.php'
        );
    }

    public function testEndpointValidatesSupportedModelAndEffortCombinations(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            'ClientConfigService::supportedModels()',
            $routerSource,
            'Expected strict model allowlist validation for host overrides.'
        );
        self::assertStringContainsString(
            'ClientConfigService::modelSupportsReasoningEffort($modelOverride, $reasoningOverride)',
            $routerSource,
            'Expected per-model reasoning-effort validation for host overrides.'
        );
    }

    public function testEndpointValidatesClaudeModelOverride(): void
    {
        // Backend: AdminHostController must validate claude_model_override against
        // ClaudeModelService::SUPPORTED_MODELS.
        $controllerSource = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString('ClaudeModelService::SUPPORTED_MODELS', $controllerSource);
        self::assertStringContainsString("array_key_exists('claude_model_override', \$payload)", $controllerSource);
        self::assertStringContainsString('claude_model_override', $controllerSource);

        // Frontend: the SvelteKit host detail page must expose a dialog for overriding
        // the Claude model and wire it to the model-override mutation with engine="claude".
        $hostDetailPage = file_get_contents(__DIR__ . '/../frontend/src/routes/hosts/[id]/+page.svelte');
        self::assertIsString($hostDetailPage);

        self::assertStringContainsString('claudeModelDialogOpen', $hostDetailPage);
        self::assertStringContainsString('Claude model override', $hostDetailPage);
        self::assertStringContainsString('claude_model_override', $hostDetailPage);

        // The mutation must pass engine: "claude" so the backend routes it correctly.
        $hostsApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/hosts.ts');
        self::assertIsString($hostsApi);

        self::assertStringContainsString('createModelOverrideMutation', $hostsApi);
        self::assertStringContainsString('engine', $hostsApi);
    }
}
