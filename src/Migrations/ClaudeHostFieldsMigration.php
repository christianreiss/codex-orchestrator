<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

class ClaudeHostFieldsMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $this->ensureColumnExists(
            $pdo,
            $databaseName,
            'hosts',
            'claude_reasoning_effort_override',
            'VARCHAR(32) DEFAULT NULL'
        );
    }
}
