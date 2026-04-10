<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class EngineHostAuthScopeMigrationTest extends TestCase
{
    public function testHostAuthStatesPrimaryKeySwapIsAtomic(): void
    {
        $source = @file_get_contents(__DIR__ . '/../src/Migrations/EngineHostAuthScopeMigration.php');
        self::assertIsString($source);

        self::assertStringContainsString(
            "ALTER TABLE host_auth_states DROP PRIMARY KEY, ADD PRIMARY KEY (host_id, engine)",
            $source,
            'Expected host_auth_states primary-key migration to swap keys in one ALTER TABLE so MySQL keeps the foreign-key-supporting index throughout the change.'
        );

        self::assertStringNotContainsString(
            "ALTER TABLE host_auth_states DROP PRIMARY KEY');",
            $source,
            'Expected host_auth_states migration to avoid dropping the primary key in a standalone ALTER TABLE before the replacement key exists.'
        );
    }
}
