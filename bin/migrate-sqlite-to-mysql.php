#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$options = getopt('', ['sqlite:', 'force']);
$sqlitePath = (string) ($options['sqlite'] ?? ($root . '/storage/database.sqlite'));
$force = array_key_exists('force', $options);

if (!is_file($sqlitePath)) {
    fwrite(STDERR, "SQLite database not found at {$sqlitePath}" . PHP_EOL);
    exit(1);
}

$backupDir = $root . '/storage/sql';
if (!is_dir($backupDir) && !mkdir($backupDir, 0775, true) && !is_dir($backupDir)) {
    fwrite(STDERR, "Unable to create backup directory at {$backupDir}" . PHP_EOL);
    exit(1);
}

$backupPath = $backupDir . '/sqlite-backup-' . date('Ymd_His') . '.db';
if (!copy($sqlitePath, $backupPath)) {
    fwrite(STDERR, 'Failed to write SQLite backup copy to ' . $backupPath . PHP_EOL);
    exit(1);
}

try {
    $source = new PDO('sqlite:' . $sqlitePath, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
} catch (PDOException $exception) {
    fwrite(STDERR, 'Could not open SQLite database: ' . $exception->getMessage() . PHP_EOL);
    exit(1);
}

$dbConfig = [
    'driver' => Config::get('DB_DRIVER', 'mysql'),
    'host' => Config::get('DB_HOST', 'mysql'),
    'port' => (int) Config::get('DB_PORT', 3306),
    'database' => Config::get('DB_DATABASE', 'codex_auth'),
    'username' => Config::get('DB_USERNAME', 'codex'),
    'password' => Config::get('DB_PASSWORD', 'codex-pass'),
    'charset' => Config::get('DB_CHARSET', 'utf8mb4'),
];

try {
    $targetDatabase = new Database($dbConfig);
    $targetDatabase->migrate();
    $target = $targetDatabase->connection();
} catch (Throwable $exception) {
    fwrite(STDERR, 'Could not connect to MySQL: ' . $exception->getMessage() . PHP_EOL);
    exit(1);
}

$existingCounts = [
    'hosts' => countRows($target, 'hosts'),
    'logs' => countRows($target, 'logs'),
    'host_auth_digests' => countRows($target, 'host_auth_digests'),
    'versions' => countRows($target, 'versions'),
];

if (!$force) {
    foreach ($existingCounts as $table => $count) {
        if ($count > 0) {
            fwrite(STDERR, "Table {$table} already has {$count} row(s). Re-run with --force to truncate before migrating." . PHP_EOL);
            exit(1);
        }
    }
} else {
    $target->exec('SET FOREIGN_KEY_CHECKS=0');
    $target->exec('TRUNCATE TABLE host_auth_digests');
    $target->exec('TRUNCATE TABLE logs');
    $target->exec('TRUNCATE TABLE hosts');
    $target->exec('TRUNCATE TABLE versions');
    $target->exec('SET FOREIGN_KEY_CHECKS=1');
}

try {
    $target->beginTransaction();

    $hostRows = fetchRows($source, 'SELECT * FROM hosts ORDER BY id ASC');
    $hostIds = [];
    $hostInsert = $target->prepare(
        'INSERT INTO hosts (id, fqdn, api_key, status, last_refresh, auth_digest, ip, client_version, wrapper_version, api_calls, created_at, updated_at)
         VALUES (:id, :fqdn, :api_key, :status, :last_refresh, :auth_digest, :ip, :client_version, :wrapper_version, :api_calls, :created_at, :updated_at)'
    );

    foreach ($hostRows as $row) {
        $hostIds[(int) $row['id']] = true;
        $hostInsert->execute([
            'id' => (int) $row['id'],
            'fqdn' => (string) $row['fqdn'],
            'api_key' => (string) $row['api_key'],
            'status' => (string) ($row['status'] ?? 'active'),
            'last_refresh' => $row['last_refresh'] ?? null,
            'auth_digest' => $row['auth_digest'] ?? null,
            'ip' => $row['ip'] ?? null,
            'client_version' => $row['client_version'] ?? null,
            'wrapper_version' => $row['wrapper_version'] ?? null,
            'api_calls' => isset($row['api_calls']) ? (int) $row['api_calls'] : 0,
            'created_at' => (string) ($row['created_at'] ?? gmdate(DATE_ATOM)),
            'updated_at' => (string) ($row['updated_at'] ?? gmdate(DATE_ATOM)),
        ]);
    }

    $logRows = fetchRows($source, 'SELECT * FROM logs ORDER BY id ASC');
    $skippedLogs = 0;
    $logInsert = $target->prepare(
        'INSERT INTO logs (id, host_id, action, details, created_at) VALUES (:id, :host_id, :action, :details, :created_at)'
    );

    foreach ($logRows as $row) {
        $hostId = $row['host_id'] ?? null;
        if ($hostId !== null && !isset($hostIds[(int) $hostId])) {
            $hostId = null;
            $skippedLogs++;
        }

        $logInsert->execute([
            'id' => (int) $row['id'],
            'host_id' => $hostId,
            'action' => (string) $row['action'],
            'details' => $row['details'] ?? null,
            'created_at' => (string) ($row['created_at'] ?? gmdate(DATE_ATOM)),
        ]);
    }

    $digestRows = fetchRows($source, 'SELECT * FROM host_auth_digests ORDER BY id ASC');
    $skippedDigests = 0;
    $digestInsert = $target->prepare(
        'INSERT INTO host_auth_digests (id, host_id, digest, last_seen, created_at) VALUES (:id, :host_id, :digest, :last_seen, :created_at)'
    );

    foreach ($digestRows as $row) {
        $hostId = $row['host_id'] ?? null;
        if ($hostId === null || !isset($hostIds[(int) $hostId])) {
            $skippedDigests++;
            continue;
        }

        $digestInsert->execute([
            'id' => (int) $row['id'],
            'host_id' => (int) $hostId,
            'digest' => (string) $row['digest'],
            'last_seen' => (string) ($row['last_seen'] ?? gmdate(DATE_ATOM)),
            'created_at' => (string) ($row['created_at'] ?? gmdate(DATE_ATOM)),
        ]);
    }

    $versionRows = fetchRows($source, 'SELECT * FROM versions ORDER BY name ASC');
    $versionInsert = $target->prepare(
        'INSERT INTO versions (name, version, updated_at) VALUES (:name, :version, :updated_at)
         ON DUPLICATE KEY UPDATE version = VALUES(version), updated_at = VALUES(updated_at)'
    );

    foreach ($versionRows as $row) {
        $versionInsert->execute([
            'name' => (string) $row['name'],
            'version' => (string) $row['version'],
            'updated_at' => (string) ($row['updated_at'] ?? gmdate(DATE_ATOM)),
        ]);
    }

    $target->commit();
} catch (Throwable $exception) {
    if ($target->inTransaction()) {
        $target->rollBack();
    }
    fwrite(STDERR, 'Migration failed: ' . $exception->getMessage() . PHP_EOL);
    exit(1);
}

fwrite(STDOUT, "SQLite snapshot copied to {$backupPath}" . PHP_EOL);
fwrite(
    STDOUT,
    sprintf(
        "Migrated %d host(s), %d log(s), %d digest(s), %d version entr(y/ies)." . PHP_EOL,
        count($hostRows),
        count($logRows) - $skippedLogs,
        count($digestRows) - $skippedDigests,
        count($versionRows)
    )
);

if ($skippedLogs > 0) {
    fwrite(STDOUT, "Skipped {$skippedLogs} log(s) with missing host references." . PHP_EOL);
}

if ($skippedDigests > 0) {
    fwrite(STDOUT, "Skipped {$skippedDigests} digest row(s) with missing host references." . PHP_EOL);
}

function countRows(PDO $pdo, string $table): int
{
    $statement = $pdo->query('SELECT COUNT(*) FROM ' . $table);

    return (int) $statement->fetchColumn();
}

function fetchRows(PDO $pdo, string $sql): array
{
    $statement = $pdo->query($sql);
    $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

    return is_array($rows) ? $rows : [];
}
