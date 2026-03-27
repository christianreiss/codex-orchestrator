<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class HttpControllerHelperRegressionTest extends TestCase
{
    public function testControllersUseAutoloadedHelperClassesForRequestParsing(): void
    {
        $files = [
            __DIR__ . '/../src/Http/Controllers/AuthController.php',
            __DIR__ . '/../src/Http/Controllers/ConfigApiController.php',
            __DIR__ . '/../src/Http/Controllers/HostApiController.php',
            __DIR__ . '/../src/Http/Controllers/McpRouteController.php',
            __DIR__ . '/../src/Http/Controllers/ProjectApiController.php',
            __DIR__ . '/../src/Http/Controllers/SkillApiController.php',
        ];

        foreach ($files as $file) {
            $source = file_get_contents($file);
            self::assertIsString($source, 'Expected controller source to be readable: ' . $file);
            self::assertStringNotContainsString('use function App\\Http\\', $source, 'Controller should not depend on non-autoloaded App\\Http helper shims: ' . $file);
        }
    }

    public function testCriticalControllersReferenceConcreteHelperClasses(): void
    {
        $skill = file_get_contents(__DIR__ . '/../src/Http/Controllers/SkillApiController.php');
        $config = file_get_contents(__DIR__ . '/../src/Http/Controllers/ConfigApiController.php');
        $mcp = file_get_contents(__DIR__ . '/../src/Http/Controllers/McpRouteController.php');

        self::assertIsString($skill);
        self::assertIsString($config);
        self::assertIsString($mcp);

        self::assertStringContainsString('RequestHelper::resolveApiKey()', $skill);
        self::assertStringContainsString('RequestHelper::resolveClientIp()', $skill);
        self::assertStringContainsString('RequestHelper::resolveApiKey()', $config);
        self::assertStringContainsString('RequestHelper::resolveBaseUrl()', $config);
        self::assertStringContainsString('RequestHelper::resolveApiKey()', $mcp);
        self::assertStringContainsString('CorsHelper::isOriginAllowed($origin)', $mcp);
    }
}
