#!/usr/bin/env php
<?php
declare(strict_types=1);

use App\Config;
use App\Support\WorkerHeartbeat;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$healthPath = trim((string) Config::get('PREFLIGHT_CRON_HEALTH_PATH', '/tmp/preflight-cron-health.json'));
if ($healthPath === '') {
    $healthPath = '/tmp/preflight-cron-health.json';
}

$interval = (int) Config::get('PREFLIGHT_CRON_INTERVAL', 60);
if ($interval <= 0) {
    $interval = 60;
}

$maxAge = (int) Config::get('PREFLIGHT_CRON_HEALTH_MAX_AGE_SECONDS', $interval + 120);
if ($maxAge <= 0) {
    $maxAge = $interval + 120;
}

$startupGrace = (int) Config::get('PREFLIGHT_CRON_HEALTH_STARTUP_GRACE_SECONDS', 120);
if ($startupGrace <= 0) {
    $startupGrace = 120;
}

$heartbeat = new WorkerHeartbeat($healthPath);
$result = $heartbeat->evaluateHealth($maxAge, $startupGrace);

if (!($result['healthy'] ?? false)) {
    $reason = (string) ($result['reason'] ?? 'unhealthy');
    fwrite(STDERR, sprintf("preflight-cron unhealthy: %s\n", $reason));
    exit(1);
}

$reason = (string) ($result['reason'] ?? 'ok');
fwrite(STDOUT, sprintf("preflight-cron healthy: %s\n", $reason));
