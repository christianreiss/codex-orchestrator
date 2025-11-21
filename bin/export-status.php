#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Services\HostStatusExporter;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
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
$statusPath = Config::get('STATUS_REPORT_PATH', $root . '/storage/host-status.txt');
$database = new Database($dbConfig);
$database->migrate();

$hostRepository = new HostRepository($database);
$hostStateRepository = new HostAuthStateRepository($database);
$authEntryRepository = new AuthEntryRepository($database);
$authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository);
$exporter = new HostStatusExporter($hostRepository, $authPayloadRepository, $hostStateRepository, $statusPath);
$outputPath = $exporter->generate();

fwrite(STDOUT, "Host status report written to {$outputPath}" . PHP_EOL);
