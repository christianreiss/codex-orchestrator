<?php

namespace App;

use PDO;
use PDOException;

class Database
{
    private PDO $pdo;
    private string $databaseName;

    /**
     * Set up a MySQL connection using the provided configuration array.
     * Expected keys: driver, host, port, database, username, password, charset.
     */
    public function __construct(array $config)
    {
        $driver = strtolower((string) ($config['driver'] ?? 'mysql'));
        if ($driver !== 'mysql') {
            throw new PDOException('Unsupported database driver: ' . $driver);
        }

        $this->databaseName = (string) ($config['database'] ?? 'codex_auth');
        $host = (string) ($config['host'] ?? 'mysql');
        $port = (int) ($config['port'] ?? 3306);
        $username = (string) ($config['username'] ?? 'root');
        $password = (string) ($config['password'] ?? '');
        $charset = (string) ($config['charset'] ?? 'utf8mb4');

        $dsn = sprintf(
            'mysql:host=%s;port=%d;dbname=%s;charset=%s',
            $host,
            $port,
            $this->databaseName,
            $charset
        );

        $this->pdo = new PDO($dsn, $username, $password, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => true,
        ]);
    }

    public function connection(): PDO
    {
        return $this->pdo;
    }

    public function migrate(): void
    {
        $collation = 'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS hosts (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                fqdn VARCHAR(255) NOT NULL UNIQUE,
                api_key CHAR(64) NOT NULL UNIQUE,
                status VARCHAR(32) NOT NULL DEFAULT 'active',
                last_refresh VARCHAR(100) NULL,
                auth_digest VARCHAR(128) NULL,
                ip VARCHAR(64) NULL,
                client_version VARCHAR(64) NULL,
                wrapper_version VARCHAR(64) NULL,
                api_calls BIGINT UNSIGNED NOT NULL DEFAULT 0,
                auth_json LONGTEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                updated_at VARCHAR(100) NOT NULL,
                INDEX idx_hosts_updated_at (updated_at)
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS logs (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NULL,
                action VARCHAR(64) NOT NULL,
                details LONGTEXT NULL,
                created_at VARCHAR(100) NOT NULL,
                INDEX idx_logs_host (host_id),
                INDEX idx_logs_created_at (created_at),
                CONSTRAINT fk_logs_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE SET NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS host_auth_digests (
                id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                host_id BIGINT UNSIGNED NOT NULL,
                digest VARCHAR(128) NOT NULL,
                last_seen VARCHAR(100) NOT NULL,
                created_at VARCHAR(100) NOT NULL,
                UNIQUE KEY unique_host_digest (host_id, digest),
                INDEX idx_auth_digest_host (host_id),
                CONSTRAINT fk_digests_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        $this->pdo->exec(
            <<<SQL
            CREATE TABLE IF NOT EXISTS versions (
                name VARCHAR(191) NOT NULL PRIMARY KEY,
                version VARCHAR(191) NOT NULL,
                updated_at VARCHAR(100) NOT NULL
            ) ENGINE=InnoDB {$collation};
            SQL
        );

        // Backfill new columns for existing databases.
        $this->ensureColumnExists('hosts', 'ip', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'client_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'wrapper_version', 'VARCHAR(64) NULL');
        $this->ensureColumnExists('hosts', 'auth_digest', 'VARCHAR(128) NULL');
        $this->ensureColumnExists('hosts', 'api_calls', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');
    }

    private function ensureColumnExists(string $table, string $column, string $definition): void
    {
        $statement = $this->pdo->prepare(
            'SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = :schema AND TABLE_NAME = :table AND COLUMN_NAME = :column'
        );

        $statement->execute([
            'schema' => $this->databaseName,
            'table' => $table,
            'column' => $column,
        ]);

        $exists = (int) $statement->fetchColumn() > 0;
        if ($exists) {
            return;
        }

        $this->pdo->exec(sprintf('ALTER TABLE %s ADD COLUMN %s %s', $table, $column, $definition));
    }
}
