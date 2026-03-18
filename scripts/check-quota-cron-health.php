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

$healthPath = trim((string) Config::get('CHATGPT_USAGE_HEALTH_PATH', '/tmp/quota-cron-health.json'));
if ($healthPath === '') {
    $healthPath = '/tmp/quota-cron-health.json';
}

$interval = (int) Config::get('CHATGPT_USAGE_CRON_INTERVAL', 3600);
if ($interval <= 0) {
    $interval = 3600;
}

$maxAge = (int) Config::get('CHATGPT_USAGE_HEALTH_MAX_AGE_SECONDS', $interval + 300);
if ($maxAge <= 0) {
    $maxAge = $interval + 300;
}

$startupGrace = (int) Config::get('CHATGPT_USAGE_HEALTH_STARTUP_GRACE_SECONDS', 120);
if ($startupGrace <= 0) {
    $startupGrace = 120;
}

$heartbeat = new WorkerHeartbeat($healthPath);
$result = $heartbeat->evaluateHealth($maxAge, $startupGrace);

if (!($result['healthy'] ?? false)) {
    $reason = (string) ($result['reason'] ?? 'unhealthy');
    fwrite(STDERR, sprintf("quota-cron unhealthy: %s\n", $reason));
    exit(1);
}

$reason = (string) ($result['reason'] ?? 'ok');
fwrite(STDOUT, sprintf("quota-cron healthy: %s\n", $reason));
