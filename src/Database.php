<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

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
        (new DatabaseMigrator($this->pdo, $this->databaseName))->migrate();
    }
}
