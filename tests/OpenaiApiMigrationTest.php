<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class OpenaiApiMigrationTest extends TestCase
{
    public function testMigrationBackfillsUseCountForExistingTables(): void
    {
        $source = @file_get_contents(__DIR__ . '/../src/Migrations/OpenaiApiMigration.php');
        self::assertIsString($source);

        self::assertStringContainsString(
            "ensureColumnExists(\$pdo, \$databaseName, 'openai_api_keys', 'use_count'",
            $source,
            'Expected openai_api_keys migration to backfill use_count on older installs.'
        );
    }
}
