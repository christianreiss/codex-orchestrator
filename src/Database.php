<?php

namespace App;

use PDO;
use PDOException;

class Database
{
    private PDO $pdo;

    public function __construct(string $path)
    {
        $directory = dirname($path);
        if (!is_dir($directory)) {
            if (!mkdir($directory, 0775, true) && !is_dir($directory)) {
                throw new PDOException("Unable to create database directory: {$directory}");
            }
        }

        $this->pdo = new PDO('sqlite:' . $path);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec('PRAGMA foreign_keys = ON;');
    }

    public function connection(): PDO
    {
        return $this->pdo;
    }

    public function migrate(): void
    {
        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fqdn TEXT NOT NULL UNIQUE,
                api_key TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL DEFAULT 'active',
                last_refresh TEXT NULL,
                auth_digest TEXT NULL,
                ip TEXT NULL,
                client_version TEXT NULL,
                wrapper_version TEXT NULL,
                api_calls INTEGER NOT NULL DEFAULT 0,
                auth_json TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NULL,
                action TEXT NOT NULL,
                details TEXT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            );
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_auth_digests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                digest TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE(host_id, digest),
                FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            );
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS versions (
                name TEXT PRIMARY KEY,
                version TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            SQL
        );

        // Backfill new columns for existing databases.
        $this->ensureColumnExists('hosts', 'ip', 'TEXT NULL');
        $this->ensureColumnExists('hosts', 'client_version', 'TEXT NULL');
        $this->ensureColumnExists('hosts', 'wrapper_version', 'TEXT NULL');
        $this->ensureColumnExists('hosts', 'auth_digest', 'TEXT NULL');
        $this->ensureColumnExists('hosts', 'api_calls', 'INTEGER NOT NULL DEFAULT 0');
    }

    private function ensureColumnExists(string $table, string $column, string $definition): void
    {
        $statement = $this->pdo->prepare('PRAGMA table_info(' . $table . ')');
        $statement->execute();
        $columns = $statement->fetchAll(PDO::FETCH_ASSOC);

        foreach ($columns as $info) {
            if (isset($info['name']) && $info['name'] === $column) {
                return;
            }
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s ADD COLUMN %s %s', $table, $column, $definition));
    }
}
