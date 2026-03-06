<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class McpRouteEphemeralAuthTest extends TestCase
{
    public function testMcpRouteUsesDedicatedCredentialAuthentication(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($source);
        self::assertStringContainsString('$host = $service->authenticateMcpCredential($apiKey, $clientIp);', $source);
    }
}
