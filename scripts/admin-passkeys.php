#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\LogRepository;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);
if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$args = $_SERVER['argv'] ?? [];
array_shift($args);
$command = array_shift($args);
[$options, $positionals] = parseCliArgs($args);

if ($command !== 'delete-user' || $positionals !== []) {
    usage();
    exit(64);
}

$username = strtolower(trim((string) ($options['username'] ?? '')));
$force = array_key_exists('force', $options);
if ($username === '') {
    fwrite(STDERR, "[admin-passkeys] --username is required\n");
    usage();
    exit(64);
}

try {
    $database = new Database([
        'driver' => Config::get('DB_DRIVER', 'mysql'),
        'host' => Config::get('DB_HOST', 'mysql'),
        'port' => (int) Config::get('DB_PORT', 3306),
        'database' => Config::get('DB_DATABASE', 'codex_auth'),
        'username' => Config::get('DB_USERNAME', 'codex'),
        'password' => Config::get('DB_PASSWORD', 'codex-pass'),
        'charset' => Config::get('DB_CHARSET', 'utf8mb4'),
    ]);

    $users = new AdminUserRepository($database);
    $passkeys = new AdminPasskeyRepository($database);
    $logs = new LogRepository($database);

    $user = $users->findByUsername($username);
    if ($user === null || empty($user['active'])) {
        fwrite(STDERR, "[admin-passkeys] unknown or inactive user: {$username}\n");
        exit(1);
    }

    $deleted = $passkeys->deleteAllForUser((int) $user['id']);
    if ($deleted === 0 && !$force) {
        fwrite(STDERR, "[admin-passkeys] no passkeys found for {$username}; rerun with --force to accept a no-op\n");
        exit(1);
    }

    $logs->log(null, 'admin.passkey.recovery.delete', [
        'user_id' => (int) $user['id'],
        'username' => (string) ($user['username'] ?? $username),
        'deleted_count' => $deleted,
        'forced' => $force,
    ]);

    if ($deleted === 0) {
        fwrite(STDOUT, "[admin-passkeys] no passkeys existed for {$username}; forced no-op recorded\n");
        exit(0);
    }

    fwrite(STDOUT, "[admin-passkeys] deleted {$deleted} passkey(s) for {$username}\n");
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, "[admin-passkeys] failed: " . $exception->getMessage() . "\n");
    exit(1);
}

function parseCliArgs(array $args): array
{
    $options = [];
    $positionals = [];

    while ($args !== []) {
        $arg = array_shift($args);
        if (!is_string($arg) || $arg === '') {
            continue;
        }

        if ($arg === '--force') {
            $options['force'] = true;
            continue;
        }

        if (str_starts_with($arg, '--username=')) {
            $options['username'] = substr($arg, strlen('--username='));
            continue;
        }

        if ($arg === '--username') {
            $next = array_shift($args);
            if (!is_string($next) || $next === '') {
                fwrite(STDERR, "[admin-passkeys] missing value for --username\n");
                exit(64);
            }
            $options['username'] = $next;
            continue;
        }

        $positionals[] = $arg;
    }

    return [$options, $positionals];
}

function usage(): void
{
    fwrite(STDERR, "Usage: php scripts/admin-passkeys.php delete-user --username <admin> [--force]\n");
}
