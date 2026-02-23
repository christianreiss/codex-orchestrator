#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\VersionRepository;
use App\Repositories\HostRepository;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);
if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

try {
    $keyManager = new EncryptionKeyManager($root);
    $keyring = $keyManager->getKeyring();
    $secretBox = new SecretBox($keyring['active_key'], $keyring['active_kid'], $keyring['keys']);

    $database = new Database([
        'driver' => Config::get('DB_DRIVER', 'mysql'),
        'host' => Config::get('DB_HOST', 'mysql'),
        'port' => (int) Config::get('DB_PORT', 3306),
        'database' => Config::get('DB_DATABASE', 'codex_auth'),
        'username' => Config::get('DB_USERNAME', 'codex'),
        'password' => Config::get('DB_PASSWORD', 'codex-pass'),
        'charset' => Config::get('DB_CHARSET', 'utf8mb4'),
    ]);

    $database->migrate();
    echo "[migrate] schema migration complete\n";

    $versionRepository = new VersionRepository($database);
    $encryptionMigrator = new AuthEncryptionMigrator($database, $secretBox);
    if ($versionRepository->get('auth_secretbox_migration_v1') === null) {
        $encryptionMigrator->migrate();
        $versionRepository->set('auth_secretbox_migration_v1', gmdate(DATE_ATOM));
        echo "[migrate] auth secretbox backfill complete\n";
    } else {
        echo "[migrate] auth secretbox backfill already applied\n";
    }

    $hostRepository = new HostRepository($database, $secretBox);
    if ($versionRepository->get('hosts_api_key_encryption_backfill_v1') === null) {
        $hostRepository->backfillApiKeyEncryption();
        $versionRepository->set('hosts_api_key_encryption_backfill_v1', gmdate(DATE_ATOM));
        echo "[migrate] hosts api-key backfill complete\n";
    } else {
        echo "[migrate] hosts api-key backfill already applied\n";
    }
} catch (Throwable $exception) {
    fwrite(STDERR, "[migrate] failed: " . $exception->getMessage() . "\n");
    exit(1);
}

