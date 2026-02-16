<?php

use PHPUnit\Framework\TestCase;

final class AdminHostModelOverrideValidationTest extends TestCase
{
    public function testEndpointIsRegisteredInRouter(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/hosts/(\\\\d+)/model$#",
            $routerSource,
            'Expected /admin/hosts/{id}/model route to exist in public/index.php'
        );
    }

    public function testEndpointValidatesSupportedModelAndEffortCombinations(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
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
}
