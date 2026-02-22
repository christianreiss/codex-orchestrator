<?php

use PHPUnit\Framework\TestCase;

final class AdminWebsocketInfoEndpointTest extends TestCase
{
    public function testEndpointIsRegistered(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            "#^/admin/ws/info$#",
            $routerSource,
            'Expected /admin/ws/info route to exist in public/index.php'
        );
    }

    public function testEndpointUsesAdminWsConfig(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            'ADMIN_WS_ENABLED',
            $routerSource,
            'Expected /admin/ws/info endpoint to consult ADMIN_WS_ENABLED'
        );
    }

    public function testEndpointReturnsWsMetadataContract(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString('ADMIN_WS_PUBLIC_URL', $routerSource);
        self::assertStringContainsString('/admin/ws', $routerSource);
        self::assertStringContainsString("'last_event_id' => \$enabled ? \$adminEventRepository->latestId() : 0", $routerSource);
        self::assertStringContainsString("'heartbeat_seconds' => \$heartbeat", $routerSource);
        self::assertStringContainsString("'backlog_limit' => \$backlog", $routerSource);
    }
}
