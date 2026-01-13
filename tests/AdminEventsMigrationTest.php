<?php

use PHPUnit\Framework\TestCase;

final class AdminEventsMigrationTest extends TestCase
{
    public function testAdminEventsTableIsMigrated(): void
    {
        $source = @file_get_contents(__DIR__ . '/../src/Database.php');
        self::assertIsString($source);

        self::assertStringContainsString(
            'CREATE TABLE IF NOT EXISTS admin_events',
            $source,
            'Expected admin_events table to be created in Database::migrate()'
        );
    }
}
