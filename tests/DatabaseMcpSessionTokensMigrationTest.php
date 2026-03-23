<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class DatabaseMcpSessionTokensMigrationTest extends TestCase
{
    public function testDatabaseMigrationCreatesMcpSessionTokensTable(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Migrations/InfrastructureMigration.php');
        self::assertIsString($source);
        self::assertStringContainsString('CREATE TABLE IF NOT EXISTS mcp_session_tokens', $source);
        self::assertStringContainsString('idx_mcp_session_tokens_expires_at', $source);
    }
}
