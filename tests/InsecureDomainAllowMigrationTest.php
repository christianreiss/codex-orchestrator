<?php

use PHPUnit\Framework\TestCase;

final class InsecureDomainAllowMigrationTest extends TestCase
{
    public function testDomainAllowTableIsMigrated(): void
    {
        $source = @file_get_contents(__DIR__ . '/../src/Database.php');
        self::assertIsString($source);

        self::assertStringContainsString(
            'CREATE TABLE IF NOT EXISTS insecure_domain_allows',
            $source,
            'Expected insecure_domain_allows table to be created in Database::migrate()'
        );
    }
}
