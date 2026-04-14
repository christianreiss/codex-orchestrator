<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminRunnerRunClaudeRouteTest extends TestCase
{
    public function testRouteIsRegistered(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($router);

        self::assertStringContainsString('#^/admin/runner/run-claude$#', $router);
        self::assertStringContainsString('runnerRunClaude', $router);
    }

    public function testControllerMethodExistsAndCallsEngineSpecificRefresher(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('public function runnerRunClaude()', $controller);
        self::assertStringContainsString('triggerRunnerRefreshClaude', $controller);
    }

    public function testServiceExposesClaudeRunnerRefreshProxy(): void
    {
        $service = file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        self::assertIsString($service);

        self::assertStringContainsString('public function triggerRunnerRefreshClaude()', $service);
    }

    public function testValidationServiceRecordsEngineScopedRunnerState(): void
    {
        $runner = file_get_contents(__DIR__ . '/../src/Services/RunnerValidationService.php');
        self::assertIsString($runner);

        self::assertStringContainsString('triggerRunnerRefreshClaude', $runner);
        self::assertStringContainsString('runner_state_claude', $runner);
        self::assertStringContainsString('runner_last_ok_claude', $runner);
        self::assertStringContainsString('runner_last_fail_claude', $runner);
    }

    public function testControllerDashboardJsInvokesRoute(): void
    {
        $dashboard = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($dashboard);

        self::assertStringContainsString("'/admin/runner/run-claude'", $dashboard);
    }
}
