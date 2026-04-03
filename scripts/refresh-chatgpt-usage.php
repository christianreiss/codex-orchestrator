#!/usr/bin/env php
<?php
declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\AdminEventRepository;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\ChatGptUsageRepository;
use App\Repositories\DashboardGraphStatsRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\LogRepository;
use App\Repositories\PricingSnapshotRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthService;
use App\Services\ChatGptUsageService;
use App\Services\DashboardGraphStatsService;
use App\Services\PricingService;
use App\Services\WrapperService;
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
$heartbeat = new WorkerHeartbeat($healthPath);
$heartbeat->recordAttempt();

function logLine(string $message, bool $error = false): void
{
    $stream = $error ? STDERR : STDOUT;
    fwrite($stream, '[' . gmdate(DATE_ATOM) . '] ' . $message . PHP_EOL);
}

try {
    $dbConfig = [
        'driver' => Config::get('DB_DRIVER', 'mysql'),
        'host' => Config::get('DB_HOST', 'mysql'),
        'port' => (int) Config::get('DB_PORT', 3306),
        'database' => Config::get('DB_DATABASE', 'codex_auth'),
        'username' => Config::get('DB_USERNAME', 'codex'),
        'password' => Config::get('DB_PASSWORD', 'codex-pass'),
        'charset' => Config::get('DB_CHARSET', 'utf8mb4'),
    ];

    $database = new Database($dbConfig);

    $keyManager = new EncryptionKeyManager($root);
    $secretBox = new SecretBox($keyManager->getKey());

    $hostRepository = new HostRepository($database, $secretBox);
    $hostStateRepository = new HostAuthStateRepository($database);
    $digestRepository = new HostAuthDigestRepository($database);
    $hostUserRepository = new HostUserRepository($database);
    $authEntryRepository = new AuthEntryRepository($database, $secretBox);
    $authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository, $secretBox);
    $adminEventRepository = new AdminEventRepository($database);
    $logRepository = new LogRepository($database, $adminEventRepository);
    $tokenUsageRepository = new TokenUsageRepository($database);
    $tokenUsageIngestRepository = new TokenUsageIngestRepository($database);
    $dashboardGraphStatsRepository = new DashboardGraphStatsRepository($database);
    $versionRepository = new VersionRepository($database);
    $pricingSnapshotRepository = new PricingSnapshotRepository($database);
    $chatGptUsageRepository = new ChatGptUsageRepository($database);

    $pricingModel = 'gpt-5.4';
    $pricingService = new PricingService(
        $pricingSnapshotRepository,
        $logRepository,
        $pricingModel,
        (string) Config::get('PRICING_URL', ''),
        null
    );

    $wrapperStoragePath = Config::get('WRAPPER_STORAGE_PATH', $root . '/storage/wrapper/cdx');
    $wrapperSeedPath = Config::get('WRAPPER_SEED_PATH', $root . '/bin/cdx');
    $wrapperService = new WrapperService($versionRepository, $wrapperStoragePath, $wrapperSeedPath, null, $secretBox);
    $dashboardGraphStatsService = new DashboardGraphStatsService(
        $dashboardGraphStatsRepository,
        $tokenUsageRepository,
        $chatGptUsageRepository,
        $versionRepository
    );

    $authService = new AuthService(
        $hostRepository,
        $authPayloadRepository,
        $hostStateRepository,
        $digestRepository,
        $hostUserRepository,
        $logRepository,
        $tokenUsageRepository,
        $tokenUsageIngestRepository,
        $pricingService,
        $versionRepository,
        $wrapperService,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        $dashboardGraphStatsService
    );

    $chatGptUsageService = new ChatGptUsageService(
        $authService,
        $chatGptUsageRepository,
        $logRepository,
        (string) Config::get('CHATGPT_BASE_URL', 'https://chatgpt.com/backend-api'),
        (float) Config::get('CHATGPT_USAGE_TIMEOUT', 10.0),
        null,
        $dashboardGraphStatsService
    );

    $result = $chatGptUsageService->fetchLatest(false);
    $snapshot = $result['snapshot'] ?? [];

    $status = (string) ($snapshot['status'] ?? 'unknown');
    $plan = (string) ($snapshot['plan_type'] ?? 'n/a');
    $primary = $snapshot['primary_used_percent'] ?? null;
    $secondary = $snapshot['secondary_used_percent'] ?? null;
    $sparkPrimary = $snapshot['spark_primary_used_percent'] ?? null;
    $sparkSecondary = $snapshot['spark_secondary_used_percent'] ?? null;
    $next = $result['next_eligible_at'] ?? ($snapshot['next_eligible_at'] ?? null);
    $cached = $result['cached'] ?? false;

    $summary = sprintf(
        'chatgpt_usage status=%s plan=%s primary=%s secondary=%s spark_primary=%s spark_secondary=%s cached=%s next=%s',
        $status,
        $plan === '' ? 'n/a' : $plan,
        $primary === null ? 'n/a' : $primary . '%',
        $secondary === null ? 'n/a' : $secondary . '%',
        $sparkPrimary === null ? 'n/a' : $sparkPrimary . '%',
        $sparkSecondary === null ? 'n/a' : $sparkSecondary . '%',
        $cached ? 'yes' : 'no',
        $next ?? 'n/a'
    );

    $heartbeat->recordSuccess([
        'summary' => $summary,
        'snapshot_status' => $status,
        'next_eligible_at' => $next,
    ]);
    logLine($summary);
} catch (Throwable $exception) {
    $heartbeat->recordFailure($exception->getMessage());
    logLine('chatgpt_usage refresh failed: ' . $exception->getMessage(), true);
    exit(1);
}
