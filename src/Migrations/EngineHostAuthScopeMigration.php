<?php

declare(strict_types=1);

namespace App\Migrations;

use PDO;

class EngineHostAuthScopeMigration implements MigrationInterface
{
    use MigrationHelper;

    public function up(PDO $pdo, string $databaseName, string $collation): void
    {
        $this->ensureColumnExists($pdo, $databaseName, 'hosts', 'claude_last_refresh', 'VARCHAR(100) NULL');

        $this->ensureHostAuthStatesPrimaryKey($pdo, $databaseName);
        $this->ensureHostAuthDigestsUniqueKey($pdo, $databaseName);
        $this->ensureIndexExists(
            $pdo,
            $databaseName,
            'host_auth_digests',
            'idx_auth_digest_host_engine',
            'INDEX idx_auth_digest_host_engine (host_id, engine)'
        );
    }

    private function ensureHostAuthStatesPrimaryKey(PDO $pdo, string $databaseName): void
    {
        $statement = $pdo->prepare(
            'SELECT COLUMN_NAME
             FROM information_schema.KEY_COLUMN_USAGE
             WHERE TABLE_SCHEMA = :schema
               AND TABLE_NAME = :table
               AND CONSTRAINT_NAME = :constraint
             ORDER BY ORDINAL_POSITION'
        );
        $statement->execute([
            'schema' => $databaseName,
            'table' => 'host_auth_states',
            'constraint' => 'PRIMARY',
        ]);

        $columns = $statement->fetchAll(PDO::FETCH_COLUMN) ?: [];
        if ($columns === ['host_id', 'engine']) {
            return;
        }

        if ($columns !== []) {
            $pdo->exec('ALTER TABLE host_auth_states DROP PRIMARY KEY');
        }

        $pdo->exec('ALTER TABLE host_auth_states ADD PRIMARY KEY (host_id, engine)');
    }

    private function ensureHostAuthDigestsUniqueKey(PDO $pdo, string $databaseName): void
    {
        $statement = $pdo->prepare(
            'SELECT COLUMN_NAME
             FROM information_schema.STATISTICS
             WHERE TABLE_SCHEMA = :schema
               AND TABLE_NAME = :table
               AND INDEX_NAME = :index
             ORDER BY SEQ_IN_INDEX'
        );
        $statement->execute([
            'schema' => $databaseName,
            'table' => 'host_auth_digests',
            'index' => 'unique_host_digest',
        ]);

        $columns = $statement->fetchAll(PDO::FETCH_COLUMN) ?: [];
        if ($columns === ['host_id', 'engine', 'digest']) {
            return;
        }

        if ($columns !== []) {
            $pdo->exec('ALTER TABLE host_auth_digests DROP INDEX unique_host_digest');
        }

        $pdo->exec('ALTER TABLE host_auth_digests ADD UNIQUE KEY unique_host_digest (host_id, engine, digest)');
    }
}
