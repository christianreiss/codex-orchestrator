#!/usr/bin/env php
<?php
declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\ChatGptUsageRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Repositories\PricingSnapshotRepository;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use App\Services\AuthService;
use App\Services\ChatGptUsageService;
use App\Services\PricingService;
use App\Services\RunnerVerifier;
use App\Services\UsageCostService;
use App\Services\WrapperService;
use App\Support\Installation;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

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
    $database->migrate();

    $keyManager = new EncryptionKeyManager($root);
    $secretBox = new SecretBox($keyManager->getKey());

    $encryptionMigrator = new AuthEncryptionMigrator($database, $secretBox);
    $encryptionMigrator->migrate();

    $hostRepository = new HostRepository($database, $secretBox);
    $hostRepository->backfillApiKeyEncryption();
    $hostStateRepository = new HostAuthStateRepository($database);
    $digestRepository = new HostAuthDigestRepository($database);
    $hostUserRepository = new HostUserRepository($database);
    $authEntryRepository = new AuthEntryRepository($database, $secretBox);
    $authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository, $secretBox);
    $logRepository = new LogRepository($database);
    $tokenUsageRepository = new TokenUsageRepository($database);
    $tokenUsageIngestRepository = new TokenUsageIngestRepository($database);
    $versionRepository = new VersionRepository($database);
    $pricingSnapshotRepository = new PricingSnapshotRepository($database);
    $pricingModel = 'gpt-5.1';
    $pricingService = new PricingService(
        $pricingSnapshotRepository,
        $logRepository,
        $pricingModel,
        (string) Config::get('PRICING_URL', ''),
        null
    );
    $usageCostService = new UsageCostService($tokenUsageRepository, $tokenUsageIngestRepository, $pricingService, $versionRepository, $pricingModel);
    $chatGptUsageRepository = new ChatGptUsageRepository($database);
    $installationId = Installation::ensure($root);

    $wrapperStoragePath = Config::get('WRAPPER_STORAGE_PATH', $root . '/storage/wrapper/cdx');
    $wrapperSeedPath = Config::get('WRAPPER_SEED_PATH', $root . '/bin/cdx');
    $wrapperService = new WrapperService($versionRepository, $wrapperStoragePath, $wrapperSeedPath, $installationId);
    $wrapperService->ensureSeeded();

    $runnerVerifier = null;
    $runnerUrl = Config::get('AUTH_RUNNER_URL', '');
    if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
        $runnerVerifier = new RunnerVerifier(
            $runnerUrl,
            (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api'),
            (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0)
        );
    }

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
        $runnerVerifier,
        null,
        $installationId
    );
    $usageCostService->backfillMissingCosts();

    $chatGptUsageService = new ChatGptUsageService(
        $authService,
        $chatGptUsageRepository,
        $logRepository,
        (string) Config::get('CHATGPT_BASE_URL', 'https://chatgpt.com/backend-api'),
        (float) Config::get('CHATGPT_USAGE_TIMEOUT', 10.0)
    );

    $result = $chatGptUsageService->fetchLatest(false);
    $snapshot = $result['snapshot'] ?? [];

    $status = (string) ($snapshot['status'] ?? 'unknown');
    $plan = (string) ($snapshot['plan_type'] ?? 'n/a');
    $primary = $snapshot['primary_used_percent'] ?? null;
    $secondary = $snapshot['secondary_used_percent'] ?? null;
    $next = $result['next_eligible_at'] ?? ($snapshot['next_eligible_at'] ?? null);
    $cached = $result['cached'] ?? false;

    $summary = sprintf(
        'chatgpt_usage status=%s plan=%s primary=%s secondary=%s cached=%s next=%s',
        $status,
        $plan === '' ? 'n/a' : $plan,
        $primary === null ? 'n/a' : $primary . '%',
        $secondary === null ? 'n/a' : $secondary . '%',
        $cached ? 'yes' : 'no',
        $next ?? 'n/a'
    );

    logLine($summary);
} catch (Throwable $exception) {
    logLine('chatgpt_usage refresh failed: ' . $exception->getMessage(), true);
    exit(1);
}
