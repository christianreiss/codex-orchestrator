<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class McpRouteEphemeralAuthTest extends TestCase
{
    public function testMcpRouteUsesDedicatedCredentialAuthentication(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/McpRouteController.php');
        self::assertIsString($source);
        self::assertStringContainsString('authenticateMcpCredential($apiKey, $clientIp)', $source);
        self::assertStringContainsString("listTools(McpServer::CAPABILITY_HOST)", $source);
        self::assertStringContainsString("dispatch(\$name, \$args, \$host, McpServer::CAPABILITY_HOST)", $source);
    }

    public function testAdminPendingInsecureApprovalsRouteExists(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($source);
        self::assertStringContainsString('/admin/insecure-approvals/pending', $source);
    }
}
