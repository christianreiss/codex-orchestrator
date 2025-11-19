#!/usr/bin/env php
<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\HostRepository;
use App\Services\HostStatusExporter;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$dbPath = Config::get('DB_PATH', $root . '/storage/database.sqlite');
$statusPath = Config::get('STATUS_REPORT_PATH', $root . '/storage/host-status.txt');
$database = new Database($dbPath);
$database->migrate();

$hostRepository = new HostRepository($database);
$exporter = new HostStatusExporter($hostRepository, $statusPath);
$outputPath = $exporter->generate();

fwrite(STDOUT, "Host status report written to {$outputPath}" . PHP_EOL);
