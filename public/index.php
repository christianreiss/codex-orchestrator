<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Http\Response;
use App\Http\Router;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\InstallTokenRepository;
use App\Repositories\LogRepository;
use App\Repositories\ChatGptUsageRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Repositories\PricingSnapshotRepository;
use App\Repositories\SlashCommandRepository;
use App\Services\AuthService;
use App\Services\WrapperService;
use App\Services\RunnerVerifier;
use App\Services\ChatGptUsageService;
use App\Services\PricingService;
use App\Services\SlashCommandService;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

// Ensure errors do not leak HTML into shell outputs.
ini_set('display_errors', '0');
ini_set('html_errors', '0');

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$keyManager = new EncryptionKeyManager($root);
$secretBox = new SecretBox($keyManager->getKey());

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

$encryptionMigrator = new AuthEncryptionMigrator($database, $secretBox);
$encryptionMigrator->migrate();

$hostRepository = new HostRepository($database);
$hostStateRepository = new HostAuthStateRepository($database);
$digestRepository = new HostAuthDigestRepository($database);
$hostUserRepository = new HostUserRepository($database);
$installTokenRepository = new InstallTokenRepository($database);
$authEntryRepository = new AuthEntryRepository($database, $secretBox);
$authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository, $secretBox);
$logRepository = new LogRepository($database);
$chatGptUsageRepository = new ChatGptUsageRepository($database);
$slashCommandRepository = new SlashCommandRepository($database);
$tokenUsageRepository = new TokenUsageRepository($database);
$versionRepository = new VersionRepository($database);
$pricingSnapshotRepository = new PricingSnapshotRepository($database);
$wrapperStoragePath = Config::get('WRAPPER_STORAGE_PATH', $root . '/storage/wrapper/cdx');
$wrapperSeedPath = Config::get('WRAPPER_SEED_PATH', $root . '/bin/cdx');
$wrapperService = new WrapperService($versionRepository, $wrapperStoragePath, $wrapperSeedPath);
$runnerVerifier = null;
$runnerUrl = Config::get('AUTH_RUNNER_URL', '');
if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
    $runnerVerifier = new RunnerVerifier(
        $runnerUrl,
        (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api'),
        (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0)
    );
}
$service = new AuthService($hostRepository, $authPayloadRepository, $hostStateRepository, $digestRepository, $hostUserRepository, $logRepository, $tokenUsageRepository, $versionRepository, $wrapperService, $runnerVerifier);
$slashCommandService = new SlashCommandService($slashCommandRepository, $logRepository);
$chatGptUsageService = new ChatGptUsageService(
    $service,
    $chatGptUsageRepository,
    $logRepository,
    (string) Config::get('CHATGPT_BASE_URL', 'https://chatgpt.com/backend-api'),
    (float) Config::get('CHATGPT_USAGE_TIMEOUT', 10.0)
);
$pricingService = new PricingService(
    $pricingSnapshotRepository,
    $logRepository,
    'gpt-5.1',
    (string) Config::get('PRICING_URL', ''),
    null
);
$wrapperService->ensureSeeded();

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$normalizedPath = rtrim($path, '/');
if ($normalizedPath === '') {
    $normalizedPath = '/';
}

const MIN_LAST_REFRESH_EPOCH = 946684800; // 2000-01-01T00:00:00Z

$rawBody = file_get_contents('php://input');
$payload = [];
if ($rawBody !== false && $rawBody !== '') {
    $payload = json_decode($rawBody, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        Response::json([
            'status' => 'error',
            'message' => 'Invalid JSON payload',
        ], 400);
    }
}

$router = new Router();

$router->add('GET', '#^/versions$#', function () use ($service) {
    $versions = $service->versionSummary();

    Response::json([
        'status' => 'ok',
        'data' => $versions,
    ]);
});

$router->add('POST', '#^/admin/versions/check$#', function () use ($service) {
    requireAdminAccess();

    $available = $service->availableClientVersion(true);
    $versions = $service->versionSummary();

    Response::json([
        'status' => 'ok',
        'data' => [
            'available_client' => $available,
            'versions' => $versions,
        ],
    ]);
});

$router->add('GET', '#^/wrapper$#', function () use ($service, $wrapperService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $baseUrl = resolveBaseUrl();
    $meta = $wrapperService->bakedForHost($host, $baseUrl);
    if ($meta['content'] === null || $meta['version'] === null) {
        Response::json([
            'status' => 'error',
            'message' => 'Wrapper not available',
        ], 404);
    }

    unset($meta['content']);
    Response::json([
        'status' => 'ok',
        'data' => $meta,
    ]);
});

$router->add('GET', '#^/wrapper/download$#', function () use ($service, $wrapperService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $baseUrl = resolveBaseUrl();
    $meta = $wrapperService->bakedForHost($host, $baseUrl);
    if ($meta['version'] === null || $meta['content'] === null) {
        Response::json([
            'status' => 'error',
            'message' => 'Wrapper not available',
        ], 404);
    }

    $fileName = 'cdx-' . ($meta['version'] ?? 'latest') . '.sh';
    header('Content-Type: text/x-shellscript');
    header('Content-Disposition: attachment; filename="' . $fileName . '"');
    if ($meta['sha256']) {
        header('X-SHA256: ' . $meta['sha256']);
        header('ETag: "' . $meta['sha256'] . '"');
    }
    if ($meta['size_bytes'] !== null) {
        header('Content-Length: ' . $meta['size_bytes']);
    }
    echo $meta['content'];
    exit;
});

$router->add('GET', '#^/install/([a-f0-9\-]{36})$#i', function ($matches) use ($installTokenRepository, $hostRepository, $logRepository, $service) {
    $tokenValue = $matches[1];
    $tokenRow = $installTokenRepository->findByToken($tokenValue);
    if (!$tokenRow) {
        installerError('Installer not found', 404);
    }
    if ($tokenRow['used_at'] ?? null) {
        installerError('Installer already used', 410);
    }
    if (installerTokenExpired($tokenRow)) {
        installerError('Installer expired', 410);
    }

    $hostId = (int) ($tokenRow['host_id'] ?? 0);
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        installerError('Installer host missing', 404);
    }

    $baseUrl = resolveInstallerBaseUrl($tokenRow);
    if ($baseUrl === '') {
        installerError('Installer base URL invalid', 500, $tokenRow['expires_at'] ?? null);
    }

    $installTokenRepository->markUsed((int) $tokenRow['id']);
    $logRepository->log($hostId, 'install.token.consume', [
        'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
    ]);

    $body = buildInstallerScript($host, $tokenRow, $baseUrl, $service->versionSummary());
    emitInstaller($body, 200, $tokenRow['expires_at'] ?? null);
});

$router->add('POST', '#^/admin/hosts/register$#', function () use ($payload, $service, $installTokenRepository, $logRepository, $hostRepository) {
    requireAdminAccess();

    $fqdn = trim((string) ($payload['fqdn'] ?? ''));
    if ($fqdn === '') {
        Response::json([
            'status' => 'error',
            'message' => 'fqdn is required',
        ], 422);
    }

    $hostPayload = $service->register($fqdn);
    $host = $hostRepository->findByFqdn($fqdn);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host could not be loaded after registration',
        ], 500);
    }

    $installTokenRepository->deleteExpired(gmdate(DATE_ATOM));

    $ttlSeconds = (int) Config::get('INSTALL_TOKEN_TTL_SECONDS', 1800);
    if ($ttlSeconds <= 0) {
        $ttlSeconds = 1800;
    }

    $expiresAt = gmdate(DATE_ATOM, time() + $ttlSeconds);
    $baseUrl = resolveInstallerBaseUrl();
    if ($baseUrl === '') {
        Response::json([
            'status' => 'error',
            'message' => 'Unable to determine public base URL for installer. Set PUBLIC_BASE_URL or ensure Host/X-Forwarded-Proto headers are forwarded.',
        ], 500);
    }
    $tokenRow = $installTokenRepository->create(
        generateUuid(),
        (int) $host['id'],
        (string) $host['api_key'],
        (string) $host['fqdn'],
        $expiresAt,
        $baseUrl
    );

    $logRepository->log((int) $host['id'], 'admin.install_token.create', [
        'fqdn' => $host['fqdn'],
        'expires_at' => $expiresAt,
        'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => array_merge($hostPayload, ['id' => (int) $host['id']]),
            'installer' => [
                'token' => $tokenRow['token'],
                'url' => rtrim($baseUrl, '/') . '/install/' . $tokenRow['token'],
                'command' => installerCommand($baseUrl, $tokenRow['token']),
                'expires_at' => $expiresAt,
            ],
        ],
    ]);
});

$router->add('GET', '#^/admin/runner$#', function () use ($logRepository, $hostRepository, $versionRepository) {
    requireAdminAccess();

    $runnerUrl = (string) Config::get('AUTH_RUNNER_URL', '');
    $enabled = trim($runnerUrl) !== '';
    $defaultBaseUrl = (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api');
    $timeoutSeconds = (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0);

    $since = gmdate(DATE_ATOM, time() - 86400);
    $latestValidationRow = $logRepository->recentByActions(['auth.validate'], 1);
    $latestRunnerStoreRow = $logRepository->recentByActions(['auth.runner_store'], 1);

    $formatLog = static function (?array $row) use ($hostRepository): ?array {
        if (!$row) {
            return null;
        }
        $detailsRaw = $row['details'] ?? null;
        $details = null;
        if (is_string($detailsRaw)) {
            $decoded = json_decode($detailsRaw, true);
            if (is_array($decoded)) {
                $details = $decoded;
            }
        } elseif (is_array($detailsRaw)) {
            $details = $detailsRaw;
        }
        $hostId = isset($row['host_id']) ? (int) $row['host_id'] : null;
        $host = null;
        if ($hostId !== null) {
            $host = $hostRepository->findById($hostId);
        }
        return [
            'id' => isset($row['id']) ? (int) $row['id'] : null,
            'created_at' => $row['created_at'] ?? null,
            'details' => $details,
            'status' => $details['status'] ?? null,
            'reason' => $details['reason'] ?? null,
            'digest' => $details['digest'] ?? null,
            'last_refresh' => $details['last_refresh'] ?? null,
            'host' => $host,
        ];
    };

    Response::json([
        'status' => 'ok',
        'data' => [
            'enabled' => $enabled,
            'runner_url' => $runnerUrl,
            'last_daily_check' => $versionRepository->get('runner_last_check', null),
            'base_url' => Config::get('AUTH_RUNNER_CODEX_BASE_URL', $defaultBaseUrl),
            'timeout_seconds' => $timeoutSeconds,
            'counts' => [
                'validations_24h' => $logRepository->countActionsSince(['auth.validate'], $since),
                'runner_store_24h' => $logRepository->countActionsSince(['auth.runner_store'], $since),
            ],
            'latest_validation' => $formatLog($latestValidationRow[0] ?? null),
            'latest_runner_store' => $formatLog($latestRunnerStoreRow[0] ?? null),
        ],
    ]);
});

$router->add('POST', '#^/admin/runner/run$#', function () use ($service) {
    requireAdminAccess();

    try {
        $result = $service->triggerRunnerRefresh();
    } catch (HttpException $exception) {
        Response::json([
            'status' => 'error',
            'message' => $exception->getMessage(),
        ], $exception->getStatusCode());
        return;
    }

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/admin/auth/upload$#', function () use ($payload, $hostRepository, $service) {
    requireAdminAccess();

    $hostIdRaw = $payload['host_id'] ?? null;
    $systemUpload = $hostIdRaw === null || $hostIdRaw === '' || $hostIdRaw === 'system' || (is_numeric($hostIdRaw) && (int) $hostIdRaw === 0);
    $host = null;
    if (!$systemUpload) {
        $hostId = (int) $hostIdRaw;
        $host = $hostRepository->findById($hostId);
        if ($host === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }
    } else {
        $host = [
            'id' => 0,
            'fqdn' => '[system]',
            'status' => 'active',
            'api_calls' => 0,
            'allow_roaming_ips' => true,
        ];
    }

    $authPayload = $payload['auth'] ?? null;
    if ($authPayload === null && isset($_FILES['file']) && is_array($_FILES['file']) && ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK) {
        $contents = file_get_contents((string) $_FILES['file']['tmp_name']);
        if ($contents !== false) {
            $decoded = json_decode($contents, true);
            if (is_array($decoded)) {
                $authPayload = $decoded;
            }
        }
    } elseif (is_string($authPayload)) {
        $decoded = json_decode($authPayload, true);
        if (is_array($decoded)) {
            $authPayload = $decoded;
        }
    }

    if (!is_array($authPayload)) {
        Response::json([
            'status' => 'error',
            'message' => 'auth payload must be valid JSON',
        ], 422);
    }

    try {
        $result = $service->handleAuth(
            ['command' => 'store', 'auth' => $authPayload],
            $host,
            'admin-upload',
            null,
            $systemUpload ? null : resolveBaseUrl()
        );
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    } catch (HttpException $exception) {
        Response::json([
            'status' => 'error',
            'message' => $exception->getMessage(),
        ], $exception->getStatusCode());
    }

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('GET', '#^/admin/api/state$#', function () use ($versionRepository) {
    requireAdminAccess();

    $disabled = $versionRepository->getFlag('api_disabled', false);

    Response::json([
        'status' => 'ok',
        'data' => ['disabled' => $disabled],
    ]);
});

$router->add('POST', '#^/admin/api/state$#', function () use ($payload, $versionRepository) {
    requireAdminAccess();

    $disabledRaw = $payload['disabled'] ?? null;
    $disabled = normalizeBoolean($disabledRaw);
    if ($disabled === null) {
        Response::json([
            'status' => 'error',
            'message' => 'disabled must be boolean',
        ], 422);
    }

    $versionRepository->set('api_disabled', $disabled ? '1' : '0');

    Response::json([
        'status' => 'ok',
        'data' => ['disabled' => $disabled],
    ]);
});

$router->add('GET', '#^/admin/quota-mode$#', function () use ($versionRepository) {
    requireAdminAccess();

    $hardFail = $versionRepository->getFlag('quota_hard_fail', true);

    Response::json([
        'status' => 'ok',
        'data' => ['hard_fail' => $hardFail],
    ]);
});

$router->add('POST', '#^/admin/quota-mode$#', function () use ($payload, $versionRepository) {
    requireAdminAccess();

    $modeRaw = $payload['hard_fail'] ?? null;
    $hardFail = normalizeBoolean($modeRaw);
    if ($hardFail === null) {
        Response::json([
            'status' => 'error',
            'message' => 'hard_fail must be boolean',
        ], 422);
    }

    $versionRepository->set('quota_hard_fail', $hardFail ? '1' : '0');

    Response::json([
        'status' => 'ok',
        'data' => ['hard_fail' => $hardFail],
    ]);
});

$router->add('GET', '#^/admin/hosts/(\d+)/auth$#', function ($matches) use ($hostRepository, $hostStateRepository, $authPayloadRepository, $service, $digestRepository) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $includeBody = filter_var($_GET['include_body'] ?? null, FILTER_VALIDATE_BOOLEAN);
    $state = $hostStateRepository->findByHostId($hostId);

    $payloadRow = null;
    if ($state && isset($state['payload_id'])) {
        $payloadRow = $authPayloadRepository->findByIdWithEntries((int) $state['payload_id']);
    }
    if ($payloadRow === null) {
        $payloadRow = $authPayloadRepository->latest();
    }

    $validated = $payloadRow ? $service->validateCanonicalPayload($payloadRow) : null;

    $auth = null;
    if ($includeBody && $validated !== null) {
        $auth = $validated['auth'];
    }

    $canonicalLastRefresh = $validated['last_refresh']
        ?? ($host['last_refresh'] ?? ($state['seen_at'] ?? null));
    $canonicalDigest = $validated['digest']
        ?? ($state['seen_digest'] ?? ($host['auth_digest'] ?? null));

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => (int) $host['id'],
                'fqdn' => $host['fqdn'],
                'status' => $host['status'],
                'last_refresh' => $host['last_refresh'] ?? ($state['seen_at'] ?? null),
                'updated_at' => $host['updated_at'] ?? null,
                'client_version' => $host['client_version'] ?? null,
                'wrapper_version' => $host['wrapper_version'] ?? null,
                'ip' => $host['ip'] ?? null,
                'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
            ],
            'canonical_last_refresh' => $canonicalLastRefresh,
            'canonical_digest' => $canonicalDigest,
            'recent_digests' => $digestRepository->recentDigests($hostId),
            'auth' => $auth,
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
        ],
    ]);
});

$router->add('DELETE', '#^/admin/hosts/(\d+)$#', function ($matches) use ($hostRepository, $digestRepository, $logRepository) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $logRepository->log($hostId, 'admin.host.delete', ['fqdn' => $host['fqdn']]);
    $hostRepository->deleteById($hostId);
    $digestRepository->deleteByHostId($hostId);

    Response::json([
        'status' => 'ok',
        'data' => ['deleted' => $hostId],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\d+)/clear$#', function ($matches) use ($hostRepository, $digestRepository, $logRepository) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $digestRepository->deleteByHostId($hostId);
    $hostRepository->clearHostAuth($hostId);
    $logRepository->log($hostId, 'admin.host.clear', ['fqdn' => $host['fqdn']]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => (int) $host['id'],
                'fqdn' => $host['fqdn'],
                'status' => $host['status'],
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\d+)/roaming$#', function ($matches) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $allow = normalizeBoolean($payload['allow'] ?? null);
    if ($allow === null) {
        Response::json([
            'status' => 'error',
            'message' => 'allow must be boolean',
        ], 422);
    }

    $hostRepository->updateAllowRoaming($hostId, $allow);
    $logRepository->log($hostId, 'admin.host.roaming', [
        'fqdn' => $host['fqdn'],
        'allow_roaming' => $allow,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => (int) $host['id'],
                'fqdn' => $host['fqdn'],
                'allow_roaming_ips' => $allow,
            ],
        ],
    ]);
});

$router->add('GET', '#^/admin/overview$#', function () use ($hostRepository, $logRepository, $service, $tokenUsageRepository, $chatGptUsageService, $pricingService, $versionRepository) {
    requireAdminAccess();
    $service->pruneStaleHosts();

    $hosts = $hostRepository->all();
    $countHosts = count($hosts);
    $latestLog = $logRepository->recent(1);
    $versions = $service->versionSummary();
    $lastRefresh = null;
    $avgRefreshDays = null;

    $sumSeconds = 0;
    $countSeconds = 0;
    foreach ($hosts as $host) {
        $lr = $host['last_refresh'] ?? null;
        if ($lr) {
            $lastRefresh = $lastRefresh ? max($lastRefresh, $lr) : $lr;
            $timestamp = strtotime($lr);
            if ($timestamp) {
                $sumSeconds += time() - $timestamp;
                $countSeconds++;
            }
        }
    }
    if ($countSeconds > 0) {
        $avgRefreshDays = ($sumSeconds / $countSeconds) / 86400;
    }

    $tokens = $tokenUsageRepository->totals();
    $tokens['top_host'] = $tokenUsageRepository->topHost();
    $monthStart = gmdate('Y-m-01\T00:00:00\Z');
    $monthEnd = gmdate('Y-m-01\T00:00:00\Z', strtotime('+1 month'));
    $tokensMonth = $tokenUsageRepository->totalsForRange($monthStart, $monthEnd);
    $pricing = $pricingService->latestPricing('gpt-5.1', false);
    $monthlyCost = $pricingService->calculateCost($pricing, $tokensMonth);
    $chatgpt = $chatGptUsageService->fetchLatest(false);
    $quotaHardFail = $versionRepository->getFlag('quota_hard_fail', true);

    Response::json([
        'status' => 'ok',
        'data' => [
            'mtls' => resolveMtls(),
            'totals' => [
                'hosts' => $countHosts,
            ],
            'latest_log_at' => $latestLog ? ($latestLog[0]['created_at'] ?? null) : null,
            'last_refresh' => $lastRefresh,
            'avg_refresh_age_days' => $avgRefreshDays,
            'versions' => $versions,
            'tokens' => $tokens,
            'tokens_month' => $tokensMonth,
            'pricing' => $pricing,
            'pricing_month_cost' => $monthlyCost,
            'chatgpt_usage' => $chatgpt['snapshot'] ?? null,
            'chatgpt_cached' => $chatgpt['cached'] ?? false,
            'chatgpt_next_eligible_at' => $chatgpt['next_eligible_at'] ?? null,
            'quota_hard_fail' => $quotaHardFail,
        ],
    ]);
});

$router->add('GET', '#^/admin/hosts$#', function () use ($hostRepository, $digestRepository, $tokenUsageRepository, $service) {
    requireAdminAccess();
    $service->pruneStaleHosts();

    $hosts = $hostRepository->all();
    $digests = $digestRepository->byHostId();

    $items = [];
    foreach ($hosts as $host) {
        $hostDigests = $digests[$host['id']] ?? [];
        $items[] = [
            'id' => (int) $host['id'],
            'fqdn' => $host['fqdn'],
            'status' => $host['status'],
            'last_refresh' => $host['last_refresh'] ?? null,
            'updated_at' => $host['updated_at'] ?? null,
            'client_version' => $host['client_version'] ?? null,
            'wrapper_version' => $host['wrapper_version'] ?? null,
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
            'ip' => $host['ip'] ?? null,
            'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
            'canonical_digest' => $host['auth_digest'] ?? null,
            'recent_digests' => array_values(array_unique($hostDigests)),
            'authed' => ($host['auth_digest'] ?? '') !== '',
            'token_usage' => $tokenUsageRepository->latestForHost((int) $host['id']),
        ];
    }

    Response::json([
        'status' => 'ok',
        'data' => [
            'hosts' => $items,
        ],
    ]);
});

$router->add('GET', '#^/admin/logs$#', function () use ($logRepository) {
    requireAdminAccess();

    $limit = resolveIntQuery('limit') ?? 50;
    if ($limit < 1) {
        $limit = 50;
    }

    $logs = $logRepository->recent($limit);

    Response::json([
        'status' => 'ok',
        'data' => [
            'logs' => $logs,
        ],
    ]);
});

$router->add('GET', '#^/admin/usage$#', function () use ($tokenUsageRepository) {
    requireAdminAccess();

    $limit = resolveIntQuery('limit') ?? 50;
    if ($limit < 1) {
        $limit = 50;
    }

    $usages = $tokenUsageRepository->recent($limit);

    Response::json([
        'status' => 'ok',
        'data' => [
            'usages' => $usages,
        ],
    ]);
});

$router->add('GET', '#^/admin/chatgpt/usage$#', function () use ($chatGptUsageService) {
    requireAdminAccess();
    $force = isset($_GET['force']) && $_GET['force'] !== '0';
    $result = $chatGptUsageService->fetchLatest($force);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/admin/chatgpt/usage/refresh$#', function () use ($chatGptUsageService) {
    requireAdminAccess();
    $result = $chatGptUsageService->fetchLatest(true);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('GET', '#^/admin/slash-commands$#', function () use ($slashCommandRepository) {
    requireAdminAccess();

    $commands = $slashCommandRepository->all();

    Response::json([
        'status' => 'ok',
        'data' => ['commands' => $commands],
    ]);
});

$router->add('GET', '#^/admin/slash-commands/([^/]+)$#', function ($matches) use ($slashCommandService) {
    requireAdminAccess();
    $filename = urldecode($matches[1]);
    try {
        $command = $slashCommandService->find($filename);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    }

    if ($command === null) {
        Response::json([
            'status' => 'error',
            'message' => 'Slash command not found',
        ], 404);
    }

    Response::json([
        'status' => 'ok',
        'data' => $command,
    ]);
});

$router->add('POST', '#^/admin/slash-commands/store$#', function () use ($payload, $slashCommandService) {
    requireAdminAccess();

    try {
        $result = $slashCommandService->store(is_array($payload) ? $payload : [], null);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    } catch (HttpException $exception) {
        Response::json([
            'status' => 'error',
            'message' => $exception->getMessage(),
        ], $exception->getStatusCode());
    }

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('DELETE', '#^/admin/slash-commands/([^/]+)$#', function ($matches) use ($slashCommandService) {
    requireAdminAccess();
    $filename = urldecode($matches[1]);
    try {
        $deleted = $slashCommandService->delete($filename);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    }

    if (!$deleted) {
        Response::json([
            'status' => 'error',
            'message' => 'Slash command not found',
        ], 404);
    }

    Response::json([
        'status' => 'ok',
        'data' => [
            'deleted' => $filename,
        ],
    ]);
});

$router->add('GET', '#^/admin/tokens$#', function () use ($tokenUsageRepository) {
    requireAdminAccess();

    $limit = resolveIntQuery('limit') ?? 50;
    if ($limit < 1) {
        $limit = 50;
    }

    $tokens = $tokenUsageRepository->topTokens($limit);

    Response::json([
        'status' => 'ok',
        'data' => [
            'tokens' => $tokens,
        ],
    ]);
});

$router->add('POST', '#^/auth$#', function () use ($payload, $service, $chatGptUsageService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $clientVersion = extractClientVersion($payload);
    $wrapperVersion = extractWrapperVersion($payload);
    $baseUrl = resolveBaseUrl();

    // Opportunistically refresh ChatGPT usage if stale (respects cooldown inside service).
    $chatGptUsageService->fetchLatest(false);

    $result = $service->handleAuth(is_array($payload) ? $payload : [], $host, $clientVersion, $wrapperVersion, $baseUrl);
    $result['chatgpt_usage'] = $chatGptUsageService->latestWindowSummary();

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('DELETE', '#^/auth$#', function () use ($service) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $force = isset($_GET['force']) && $_GET['force'] !== '0';

    $host = $service->authenticate($apiKey, $clientIp, $force);
    $service->deleteHost($host);

    Response::json([
        'status' => 'ok',
        'data' => [
            'deleted' => $host['fqdn'],
        ],
    ]);
});

$router->add('GET', '#^/slash-commands$#', function () use ($service, $slashCommandService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $commands = $slashCommandService->listCommands($host, true);

    Response::json([
        'status' => 'ok',
        'data' => [
            'commands' => $commands,
        ],
    ]);
});

$router->add('POST', '#^/slash-commands/retrieve$#', function () use ($payload, $service, $slashCommandService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $filename = is_array($payload) ? (string) ($payload['filename'] ?? '') : '';
    $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
    $result = $slashCommandService->retrieve($filename, $sha, $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/slash-commands/store$#', function () use ($payload, $service, $slashCommandService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $result = $slashCommandService->store(is_array($payload) ? $payload : [], $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/host/users$#', function () use ($payload, $service) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $username = is_array($payload) ? (string) ($payload['username'] ?? '') : '';
    $hostname = is_array($payload) ? (string) ($payload['hostname'] ?? '') : '';
    $users = $service->recordHostUser($host, $username, $hostname);

    Response::json([
        'status' => 'ok',
        'data' => [
            'users' => $users,
        ],
    ]);
});

$router->add('POST', '#^/usage$#', function () use ($payload, $service) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    try {
        $data = $service->recordTokenUsage($host, is_array($payload) ? $payload : []);
    } catch (Throwable $exception) {
        error_log('Usage ingestion failed: ' . $exception->getMessage());
        Response::json([
            'status' => 'ok',
            'data' => [
                'recorded' => false,
                'reason' => 'usage ingestion failed',
            ],
        ]);
    }

    Response::json([
        'status' => 'ok',
        'data' => $data,
    ]);
});

try {
    $handled = $router->dispatch($method, $normalizedPath);
    if (!$handled) {
        Response::json([
            'status' => 'error',
            'message' => 'Route not found',
        ], 404);
    }
} catch (ValidationException $exception) {
    Response::json([
        'status' => 'error',
        'message' => 'Validation failed',
        'errors' => $exception->getErrors(),
    ], 422);
} catch (HttpException $exception) {
    Response::json([
        'status' => 'error',
        'message' => $exception->getMessage(),
    ], $exception->getStatusCode());
} catch (Throwable $exception) {
    error_log('Unhandled exception: ' . $exception->getMessage());
    error_log($exception->getTraceAsString());
    Response::json([
        'status' => 'error',
        'message' => 'Unexpected error',
    ], 500);
}

function resolveMtls(): array
{
    $fingerprint = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? '';
    if ($fingerprint !== '') {
        return [
            'fingerprint' => $fingerprint,
            'subject' => $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? null,
            'issuer' => $_SERVER['HTTP_X_MTLS_ISSUER'] ?? null,
        ];
    }

    return [];
}

function resolveClientIp(): ?string
{
    $headers = ['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'];
    foreach ($headers as $header) {
        $value = $_SERVER[$header] ?? null;
        if ($value) {
            $parts = array_filter(array_map('trim', explode(',', $value)));
            if ($parts) {
                return $parts[0];
            }
        }
    }

    $remote = $_SERVER['REMOTE_ADDR'] ?? null;
    return $remote ?: null;
}

function extractClientVersion(mixed $payload): ?string
{
    if (is_array($payload) && array_key_exists('client_version', $payload)) {
        $value = normalizeVersionValue($payload['client_version']);
        if ($value !== null) {
            return $value;
        }
    }

    $aliases = ['client_version', 'cdx_version'];
    foreach ($aliases as $alias) {
        $fromQuery = resolveQueryParam($alias);
        if ($fromQuery !== null) {
            return $fromQuery;
        }
    }

    return null;
}

function extractWrapperVersion(mixed $payload): ?string
{
    if (is_array($payload) && array_key_exists('wrapper_version', $payload)) {
        $value = normalizeVersionValue($payload['wrapper_version']);
        if ($value !== null) {
            return $value;
        }
    }

    $fromQuery = resolveQueryParam('wrapper_version');
    if ($fromQuery !== null) {
        return $fromQuery;
    }

    return null;
}

function resolveQueryParam(string $key): ?string
{
    if (!isset($_GET[$key])) {
        return null;
    }

    return normalizeVersionValue($_GET[$key]);
}

function normalizeVersionValue(mixed $value): ?string
{
    if (!is_string($value)) {
        return null;
    }

    $value = trim($value);

    return $value === '' ? null : $value;
}

function normalizeBoolean(mixed $value): ?bool
{
    if (is_bool($value)) {
        return $value;
    }

    if (is_int($value)) {
        if ($value === 1) {
            return true;
        }
        if ($value === 0) {
            return false;
        }
    }

    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if ($normalized === '1' || $normalized === 'true' || $normalized === 'yes' || $normalized === 'on') {
            return true;
        }
        if ($normalized === '0' || $normalized === 'false' || $normalized === 'no' || $normalized === 'off') {
            return false;
        }
    }

    return null;
}

function resolveBaseUrl(): string
{
    $host = $_SERVER['HTTP_HOST'] ?? 'localhost';
    $scheme = 'http';

    $forwardedProto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
    if ($forwardedProto !== '') {
        $schemeCandidate = explode(',', $forwardedProto)[0] ?? '';
        $scheme = strtolower(trim($schemeCandidate)) === 'https' ? 'https' : 'http';
    } elseif (!empty($_SERVER['REQUEST_SCHEME'])) {
        $scheme = $_SERVER['REQUEST_SCHEME'];
    } elseif (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') {
        $scheme = 'https';
    }

    return sprintf('%s://%s', $scheme, $host);
}

function resolveApiKey(): ?string
{
    $header = $_SERVER['HTTP_X_API_KEY'] ?? null;
    if ($header) {
        return $header;
    }

    $authorization = $_SERVER['HTTP_AUTHORIZATION'] ?? null;
    if ($authorization && str_starts_with($authorization, 'Bearer ')) {
        return substr($authorization, 7);
    }

    return null;
}

function escapeForSingleQuotes(string $value): string
{
    return str_replace("'", "'\"'\"'", $value);
}

function generateUuid(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40);
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80);

    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

function resolveInstallerBaseUrl(?array $tokenRow = null): string
{
    $baseUrl = '';
    if ($tokenRow && isset($tokenRow['base_url']) && is_string($tokenRow['base_url'])) {
        $baseUrl = trim((string) $tokenRow['base_url']);
    }

    if ($baseUrl === '') {
        $baseUrl = resolveBaseUrl();
    }

    if ($baseUrl === '' || $baseUrl === 'http://' || $baseUrl === 'https://') {
        $fallbackBase = Config::get('PUBLIC_BASE_URL', '');
        if (is_string($fallbackBase) && trim($fallbackBase) !== '') {
            $baseUrl = trim($fallbackBase);
        }
    }

    $baseUrl = rtrim($baseUrl, '/');

    if (!preg_match('#^https?://[A-Za-z0-9._:-]+(/.*)?$#', $baseUrl)) {
        return '';
    }

    return $baseUrl;
}

function installerCommand(string $baseUrl, string $token): string
{
    $base = rtrim($baseUrl, '/');

    return sprintf('curl -fsSL "%s/install/%s" | bash', $base, $token);
}

function installerTokenExpired(array $tokenRow): bool
{
    $expires = strtotime($tokenRow['expires_at'] ?? '');
    if ($expires === false) {
        return true;
    }

    return $expires < time();
}

function buildInstallerScript(array $host, array $tokenRow, string $baseUrl, array $versions): string
{
    $base = rtrim($baseUrl, '/');
    $apiKeyRaw = (string) ($tokenRow['api_key'] ?? ($host['api_key'] ?? ''));
    $fqdnRaw = (string) (($tokenRow['fqdn'] ?? '') !== '' ? $tokenRow['fqdn'] : ($host['fqdn'] ?? ''));

    if ($apiKeyRaw === '' || $fqdnRaw === '' || $base === '' || $base === 'http://' || $base === 'https://') {
        installerError('Installer metadata missing (fqdn/base/api key)', 500);
    }

    $apiKey = escapeForSingleQuotes($apiKeyRaw);
    $fqdn = escapeForSingleQuotes($fqdnRaw);
    $codexVersion = $versions['client_version'] ?? null;
    if ($codexVersion === null || $codexVersion === '') {
        $codexVersion = '0.63.0';
    }
    $codexVersion = escapeForSingleQuotes((string) $codexVersion);
    $baseEscaped = escapeForSingleQuotes($base);

    $template = <<<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
BASE_URL='__BASE__'
API_KEY='__API__'
FQDN='__FQDN__'
CODEX_VERSION='__CODEX__'

tmpdir="$(mktemp -d)"
cleanup() { rm -rf "$tmpdir"; }
trap cleanup EXIT

echo "Installing Codex for __FQDN__ via __BASE__"

curl -fsSL "__BASE__/wrapper/download" -H "X-API-Key: __API__" -o "$tmpdir/cdx"
chmod +x "$tmpdir/cdx"
install_path="/usr/local/bin/cdx"
if ! install -m 755 "$tmpdir/cdx" "$install_path" 2>/dev/null; then
  install_path="$HOME/.local/bin/cdx"
  mkdir -p "$(dirname "$install_path")"
  install -m 755 "$tmpdir/cdx" "$install_path"
fi

arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) asset="codex-x86_64-unknown-linux-gnu.tar.gz" ;;
  aarch64|arm64) asset="codex-aarch64-unknown-linux-gnu.tar.gz" ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

curl -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}" -o "$tmpdir/codex.tar.gz"
tar -xzf "$tmpdir/codex.tar.gz" -C "$tmpdir"
codex_bin="$(find "$tmpdir" -type f -name "codex*" | head -n1)"
if [ -z "$codex_bin" ]; then
  echo "Codex binary not found in archive" >&2
  exit 1
fi

codex_path="/usr/local/bin/codex"
if ! install -m 755 "$codex_bin" "$codex_path" 2>/dev/null; then
  codex_path="$HOME/.local/bin/codex"
  mkdir -p "$(dirname "$codex_path")"
  install -m 755 "$codex_bin" "$codex_path"
fi

mkdir -p "$HOME/.codex"
"$install_path" --version
"$codex_path" -V || true
echo "Install complete for __FQDN__"
SCRIPT;

    return strtr($template, [
        '__BASE__' => $baseEscaped,
        '__API__' => $apiKey,
        '__FQDN__' => $fqdn,
        '__CODEX__' => $codexVersion,
    ]);
}

function emitInstaller(string $body, int $status = 200, ?string $expiresAt = null): void
{
    http_response_code($status);
    header('Content-Type: text/x-shellscript; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store, must-revalidate');
    if ($expiresAt !== null) {
        header('X-Installer-Expires-At: ' . $expiresAt);
    }
    echo $body;
    exit;
}

function installerError(string $message, int $status = 400, ?string $expiresAt = null): void
{
    emitInstaller('echo "' . addslashes($message) . "\" >&2\nexit 1\n", $status, $expiresAt);
}

function resolveAdminKey(): ?string
{
    $headerKeys = [
        'HTTP_X_ADMIN_KEY',
        'HTTP_AUTHORIZATION',
    ];

    foreach ($headerKeys as $key) {
        if (isset($_SERVER[$key]) && is_string($_SERVER[$key])) {
            $value = trim($_SERVER[$key]);
            if ($value !== '') {
                if (str_starts_with($value, 'Bearer ')) {
                    return substr($value, 7);
                }

                return $value;
            }
        }
    }

    return null;
}

function requireMtls(): void
{
    $present = $_SERVER['HTTP_X_MTLS_PRESENT'] ?? '';
    if ($present === '') {
        Response::json([
            'status' => 'error',
            'message' => 'Client certificate required for admin access',
        ], 403);
    }
}

function requireAdminAccess(): void
{
    requireMtls();

    $configured = Config::get('DASHBOARD_ADMIN_KEY', '');
    if ($configured === '') {
        return;
    }

    $provided = resolveAdminKey();
    if ($provided === null || !hash_equals($configured, $provided)) {
        Response::json([
            'status' => 'error',
            'message' => 'Admin key required',
        ], 401);
    }
}

function resolveIntQuery(string $key): ?int
{
    if (!isset($_GET[$key])) {
        return null;
    }

    if (is_array($_GET[$key])) {
        return null;
    }

    $filtered = filter_var($_GET[$key], FILTER_VALIDATE_INT);
    if ($filtered === false) {
        return null;
    }

    return (int) $filtered;
}
