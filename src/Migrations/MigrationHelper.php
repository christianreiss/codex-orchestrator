<?php

namespace App\Migrations;

use PDO;

trait MigrationHelper
{
    protected function columnExists(PDO $pdo, string $databaseName, string $table, string $column): bool
    {
        $statement = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        return (int) $statement->fetchColumn() > 0;
    }

    protected function dropTableIfExists(PDO $pdo, string $databaseName, string $table): void
    {
        $statement = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table'
        );

        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if (!$exists) {
            return;
        }

        $pdo->exec(sprintf('DROP TABLE %s', $table));
    }

    protected function ensureColumnExists(PDO $pdo, string $databaseName, string $table, string $column, string $definition): void
    {
        $statement = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $pdo->exec(sprintf('ALTER TABLE %s ADD COLUMN %s %s', $table, $column, $definition));
    }

    protected function ensureColumnLength(PDO $pdo, string $databaseName, string $table, string $column, int $length): void
    {
        $statement = $pdo->prepare(
            'SELECT CHARACTER_MAXIMUM_LENGTH FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        $currentLength = $statement->fetchColumn();
        if ($currentLength !== false && (int) $currentLength >= $length) {
            return;
        }

        $pdo->exec(sprintf('ALTER TABLE %s MODIFY COLUMN %s CHAR(%d) NOT NULL', $table, $column, $length));
    }

    protected function ensureIndexExists(PDO $pdo, string $databaseName, string $table, string $index, string $definition): void
    {
        $statement = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND INDEX_NAME = :index'
        );

        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
            'index' => $index,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $pdo->exec(sprintf('ALTER TABLE %s ADD %s', $table, $definition));
    }

    protected function ensureForeignKeyExists(PDO $pdo, string $databaseName, string $table, string $constraint, string $definition): void
    {
        $statement = $pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND CONSTRAINT_NAME = :constraint AND CONSTRAINT_TYPE = :type'
        );

        $statement->execute([
            'schema' => $databaseName,
            'table' => $table,
            'constraint' => $constraint,
            'type' => 'FOREIGN KEY',
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $pdo->exec(sprintf('ALTER TABLE %s ADD CONSTRAINT %s %s', $table, $constraint, $definition));
    }
}
