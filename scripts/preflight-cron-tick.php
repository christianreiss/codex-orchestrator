#!/usr/bin/env php
<?php
declare(strict_types=1);

use App\Config;
use App\Database;
use App\Repositories\AdminEventRepository;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\ClientVersionService;
use App\Services\RunnerValidationService;
use App\Services\RunnerVerifier;
use App\Services\WrapperService;
use App\Support\Engine;
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
$heartbeat = new WorkerHeartbeat($healthPath);
$heartbeat->recordAttempt();

function preflightLog(string $message, bool $error = false): void
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
    $keyring = $keyManager->getKeyring();
    $secretBox = new SecretBox($keyring['active_key'], $keyring['active_kid'], $keyring['keys']);

    $hostRepository = new HostRepository($database, $secretBox);
    $hostStateRepository = new HostAuthStateRepository($database);
    $authEntryRepository = new AuthEntryRepository($database, $secretBox);
    $authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository, $secretBox);
    $adminEventRepository = new AdminEventRepository($database);
    $logRepository = new LogRepository($database, $adminEventRepository);
    $versionRepository = new VersionRepository($database);

    $runnerVerifier = null;
    $runnerUrl = Config::get('AUTH_RUNNER_URL', '');
    if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
        $runnerVerifier = new RunnerVerifier(
            $runnerUrl,
            (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api'),
            (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0),
            (string) Config::get('AUTH_RUNNER_SHARED_SECRET', ''),
            (string) Config::get('AUTH_RUNNER_SKILL_SUMMARY_URL', ''),
            (string) Config::get('AUTH_RUNNER_SKILL_GENERATE_URL', ''),
            (string) Config::get('AUTH_RUNNER_MEMORY_SUMMARY_URL', '')
        );
    }

    $runnerValidationService = new RunnerValidationService(
        $hostRepository,
        $authPayloadRepository,
        $hostStateRepository,
        $logRepository,
        $versionRepository,
        $runnerVerifier
    );

    $wrapperStoragePath = Config::get('WRAPPER_STORAGE_PATH', $root . '/storage/wrapper/cdx');
    $wrapperSeedPath = Config::get('WRAPPER_SEED_PATH', $root . '/bin/cdx');
    $clxStoragePath = Config::get('CLX_WRAPPER_STORAGE_PATH', $root . '/storage/wrapper/clx');
    $clxSeedPath = Config::get('CLX_WRAPPER_SEED_PATH', $root . '/bin/clx');
    $wrapperService = new WrapperService($versionRepository, $wrapperStoragePath, $wrapperSeedPath, null, $secretBox, $clxStoragePath, $clxSeedPath);
    $clientVersionService = new ClientVersionService($hostRepository, $versionRepository, $wrapperService, $runnerVerifier, null);

    $runnerInterval = (int) Config::get('PREFLIGHT_RUNNER_INTERVAL', 600);
    if ($runnerInterval <= 0) {
        $runnerInterval = 600;
    }
    $versionInterval = (int) Config::get('PREFLIGHT_VERSION_INTERVAL', 10800);
    if ($versionInterval <= 0) {
        $versionInterval = 10800;
    }
    $rejectedRetentionSeconds = (int) Config::get('PREFLIGHT_REJECTED_RETENTION_SECONDS', 7 * 86400);
    if ($rejectedRetentionSeconds <= 0) {
        $rejectedRetentionSeconds = 7 * 86400;
    }

    $forceRun = false;
    $forceMarker = $versionRepository->get('preflight_force_run');
    if (is_string($forceMarker) && trim($forceMarker) !== '' && trim($forceMarker) !== '0') {
        $forceRun = true;
        $versionRepository->set('preflight_force_run', '0');
    }

    $now = time();
    $bootChanged = $runnerValidationService->recordCurrentBootId();

    $summaryParts = [];

    // 1. Promote or reject pending payloads for every engine.
    $pendingTotals = ['verified' => 0, 'rejected' => 0, 'skipped' => 0];
    foreach (Engine::ALL as $engine) {
        $pending = $authPayloadRepository->allPending($engine);
        foreach ($pending as $row) {
            $outcome = $runnerValidationService->verifyPendingPayload($row, $engine);
            $state = (string) ($outcome['state'] ?? 'skipped');
            if (!isset($pendingTotals[$state])) {
                $pendingTotals[$state] = 0;
            }
            $pendingTotals[$state]++;
            preflightLog(sprintf(
                'pending_verification engine=%s payload_id=%d state=%s reason=%s canonical_moved=%s',
                $engine,
                (int) ($outcome['payload_id'] ?? 0),
                $state,
                (string) ($outcome['reason'] ?? ''),
                !empty($outcome['canonical_moved']) ? 'yes' : 'no'
            ));
        }
    }
    $summaryParts[] = sprintf(
        'pending verified=%d rejected=%d skipped=%d',
        $pendingTotals['verified'] ?? 0,
        $pendingTotals['rejected'] ?? 0,
        $pendingTotals['skipped'] ?? 0
    );

    // 2. Periodic runner daily check against the current canonical for each engine.
    $runnerChecked = false;
    foreach (Engine::ALL as $engine) {
        if ($runnerVerifier === null) {
            break;
        }
        $lastCheckKey = $engine === Engine::CLAUDE ? 'runner_last_check_claude' : 'runner_last_check';
        $lastCheckRaw = $versionRepository->get($lastCheckKey);
        $lastCheckTs = is_string($lastCheckRaw) && $lastCheckRaw !== '' ? strtotime($lastCheckRaw) : false;
        $intervalElapsed = $lastCheckTs === false || ($now - (int) $lastCheckTs) >= $runnerInterval;

        if (!($forceRun || $bootChanged || $intervalElapsed)) {
            continue;
        }

        $canonical = $runnerValidationService->resolveCanonicalPayload($engine);
        if ($canonical === null) {
            continue;
        }

        $host = $runnerValidationService->resolveRunnerHost(null, $canonical) ?? [];
        $versions = $clientVersionService->versionSnapshotForEngine($engine);
        $runnerValidationService->runnerDailyCheck(
            $canonical,
            $host,
            $versions,
            true,
            'preflight_cron',
            $engine
        );
        $runnerChecked = true;
        preflightLog('runner_daily_check engine=' . $engine);
    }
    $summaryParts[] = 'runner_check=' . ($runnerChecked ? 'yes' : 'no');

    // 3. Refresh GitHub client version cache when stale.
    $versionRefreshed = false;
    $clientAvailable = $versionRepository->getWithMetadata('client_available');
    $clientUpdatedAt = is_array($clientAvailable) ? ($clientAvailable['updated_at'] ?? null) : null;
    $clientUpdatedTs = is_string($clientUpdatedAt) && $clientUpdatedAt !== '' ? strtotime($clientUpdatedAt) : false;
    if ($forceRun || $clientUpdatedTs === false || ($now - (int) $clientUpdatedTs) >= $versionInterval) {
        $clientVersionService->refreshAvailableClientVersion();
        $versionRefreshed = true;
        preflightLog('refreshed_client_available');
    }
    $summaryParts[] = 'version_refresh=' . ($versionRefreshed ? 'yes' : 'no');

    // 4. Sweep rejected rows older than retention window.
    $sweptTotal = 0;
    foreach (Engine::ALL as $engine) {
        $sweptTotal += $authPayloadRepository->deleteRejectedOlderThan($rejectedRetentionSeconds, $engine);
    }
    if ($sweptTotal > 0) {
        preflightLog('swept_rejected rows=' . $sweptTotal);
    }
    $summaryParts[] = 'rejected_swept=' . $sweptTotal;

    if ($forceRun) {
        $summaryParts[] = 'forced=yes';
    }
    if ($bootChanged) {
        $summaryParts[] = 'boot_changed=yes';
    }

    $summary = implode(' ', $summaryParts);
    $heartbeat->recordSuccess([
        'summary' => $summary,
        'pending_verified' => $pendingTotals['verified'] ?? 0,
        'pending_rejected' => $pendingTotals['rejected'] ?? 0,
        'pending_skipped' => $pendingTotals['skipped'] ?? 0,
        'runner_checked' => $runnerChecked,
        'version_refreshed' => $versionRefreshed,
        'rejected_swept' => $sweptTotal,
        'forced' => $forceRun,
    ]);
    preflightLog('preflight_tick_ok ' . $summary);
} catch (Throwable $exception) {
    $heartbeat->recordFailure($exception->getMessage());
    preflightLog('preflight_tick failed: ' . $exception->getMessage(), true);
    exit(1);
}
