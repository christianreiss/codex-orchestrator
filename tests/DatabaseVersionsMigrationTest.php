<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class DatabaseVersionsMigrationTest extends TestCase
{
    public function testDatabaseMigrationPromotesVersionsValueColumnToLongtext(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Migrations/InfrastructureMigration.php');
        self::assertIsString($source);
        self::assertStringContainsString('CREATE TABLE IF NOT EXISTS versions', $source);
        self::assertStringContainsString('version LONGTEXT NOT NULL', $source);
        self::assertStringContainsString('ALTER TABLE versions', $source);
        self::assertStringContainsString('MODIFY COLUMN version LONGTEXT NOT NULL', $source);
    }
}
