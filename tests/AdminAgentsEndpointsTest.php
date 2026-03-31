<?php

use PHPUnit\Framework\TestCase;

final class AdminAgentsEndpointsTest extends TestCase
{
    public function testAdminAgentsVersionAndRevertRoutesAreRegistered(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/agents/versions/(\\d+)$#",
            $routerSource,
            'Expected /admin/agents/versions/{id} route to exist in public/index.php'
        );
        self::assertStringContainsString(
            "#^/admin/agents/revert$#",
            $routerSource,
            'Expected /admin/agents/revert route to exist in public/index.php'
        );
        self::assertStringContainsString(
            "#^/admin/agents/retention$#",
            $routerSource,
            'Expected /admin/agents/retention route to exist in public/index.php'
        );
    }

    public function testAdminConfigControllerUsesVersionReadAndRevertServiceMethods(): void
    {
        $source = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminConfigController.php');
        self::assertIsString($source);

        self::assertStringContainsString('public function agentsVersion(int $versionId): void', $source);
        self::assertStringContainsString('adminFetchVersion($versionId)', $source);
        self::assertStringContainsString('public function agentsRevert(array $payload): void', $source);
        self::assertStringContainsString('revertVersion($versionId ?? 0)', $source);
        self::assertStringContainsString('public function agentsRetention(array $payload): void', $source);
        self::assertStringContainsString("updateBackupRetention(is_array(\$payload) ? (\$payload['backup_limit'] ?? null) : null)", $source);
    }
}
