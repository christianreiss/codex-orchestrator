<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

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
use App\Repositories\IpRateLimitRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\VersionRepository;
use App\Repositories\PricingSnapshotRepository;
use App\Repositories\SlashCommandRepository;
use App\Repositories\AgentsRepository;
use App\Repositories\MemoryRepository;
use App\Repositories\ClientConfigRepository;
use App\Repositories\McpAccessLogRepository;
use App\Services\AuthService;
use App\Services\WrapperService;
use App\Services\RunnerVerifier;
use App\Services\ChatGptUsageService;
use App\Services\PricingService;
use App\Services\CostHistoryService;
use App\Services\UsageCostService;
use App\Services\SlashCommandService;
use App\Services\AgentsService;
use App\Services\MemoryService;
use App\Services\ClientConfigService;
use App\Mcp\McpServer;
use App\Mcp\McpToolNotFoundException;
use InvalidArgumentException;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use App\Security\RateLimiter;
use App\Support\Installation;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

// Ensure errors do not leak HTML into shell outputs.
ini_set('display_errors', '0');
ini_set('html_errors', '0');

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$installationId = Installation::ensure($root);

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

$hostRepository = new HostRepository($database, $secretBox);
$hostRepository->backfillApiKeyEncryption();
$hostStateRepository = new HostAuthStateRepository($database);
$digestRepository = new HostAuthDigestRepository($database);
$hostUserRepository = new HostUserRepository($database);
$installTokenRepository = new InstallTokenRepository($database);
$authEntryRepository = new AuthEntryRepository($database, $secretBox);
$authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository, $secretBox);
$logRepository = new LogRepository($database);
$chatGptUsageRepository = new ChatGptUsageRepository($database);
$slashCommandRepository = new SlashCommandRepository($database);
$agentsRepository = new AgentsRepository($database);
$memoryRepository = new MemoryRepository($database);
$clientConfigRepository = new ClientConfigRepository($database);
$mcpAccessLogRepository = new McpAccessLogRepository($database);
$ipRateLimitRepository = new IpRateLimitRepository($database);
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
$wrapperStoragePath = Config::get('WRAPPER_STORAGE_PATH', $root . '/storage/wrapper/cdx');
$wrapperSeedPath = Config::get('WRAPPER_SEED_PATH', $root . '/bin/cdx');
$wrapperService = new WrapperService($versionRepository, $wrapperStoragePath, $wrapperSeedPath, $installationId);
$runnerVerifier = null;
$runnerUrl = Config::get('AUTH_RUNNER_URL', '');
if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
    $runnerVerifier = new RunnerVerifier(
        $runnerUrl,
        (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api'),
        (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0)
    );
}
$rateLimiter = new RateLimiter($ipRateLimitRepository);
$service = new AuthService($hostRepository, $authPayloadRepository, $hostStateRepository, $digestRepository, $hostUserRepository, $logRepository, $tokenUsageRepository, $tokenUsageIngestRepository, $pricingService, $versionRepository, $wrapperService, $runnerVerifier, $rateLimiter, $installationId);
$slashCommandService = new SlashCommandService($slashCommandRepository, $logRepository);
$agentsService = new AgentsService($agentsRepository, $logRepository);
$memoryService = new MemoryService($memoryRepository, $logRepository);
$mcpServer = new McpServer($memoryService, $root);
$clientConfigService = new ClientConfigService($clientConfigRepository, $logRepository);
$chatGptUsageService = new ChatGptUsageService(
    $service,
    $chatGptUsageRepository,
    $logRepository,
    (string) Config::get('CHATGPT_BASE_URL', 'https://chatgpt.com/backend-api'),
    (float) Config::get('CHATGPT_USAGE_TIMEOUT', 10.0)
);
$costHistoryService = new CostHistoryService($tokenUsageRepository, $pricingService, $pricingModel);
$usageCostService = new UsageCostService($tokenUsageRepository, $tokenUsageIngestRepository, $pricingService, $versionRepository, $pricingModel);
$wrapperService->ensureSeeded();
$usageCostService->backfillMissingCosts();

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$normalizedPath = rtrim($path, '/');
if ($normalizedPath === '') {
    $normalizedPath = '/';
}

// First non-admin API hit after ~8 hours (or boot): refresh GitHub client version cache and run auth runner once.
if (!str_starts_with($normalizedPath, '/admin')) {
    try {
        $service->runDailyPreflight();
    } catch (\Throwable $exception) {
        error_log('[preflight] scheduled check failed: ' . $exception->getMessage());
    }
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

$apiDisabled = $versionRepository->getFlag('api_disabled', false);
$apiDisableBypass = $normalizedPath === '/admin/api/state';
if ($apiDisabled && !$apiDisableBypass) {
    Response::json([
        'status' => 'error',
        'message' => 'API disabled by administrator',
    ], 503);
}

$clientIp = resolveClientIp();
enforceGlobalRateLimit($rateLimiter, $clientIp, $method, $normalizedPath);

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

    $secureRaw = $payload['secure'] ?? true;
    $secure = $secureRaw === null ? true : normalizeBoolean($secureRaw);
    if ($secure === null) {
        Response::json([
            'status' => 'error',
            'message' => 'secure must be boolean',
        ], 422);
    }
    $vipRaw = $payload['vip'] ?? false;
    $vip = $vipRaw === null ? false : normalizeBoolean($vipRaw);
    if ($vip === null) {
        Response::json([
            'status' => 'error',
            'message' => 'vip must be boolean',
        ], 422);
    }

    $hostPayload = $service->register($fqdn, $secure);
    $host = $hostRepository->findByFqdn($fqdn);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host could not be loaded after registration',
        ], 500);
    }

    if ($vip !== null) {
        $hostRepository->updateVip((int) $host['id'], $vip);
        $host = $hostRepository->findById((int) $host['id']) ?? $host;
        $hostPayload['vip'] = $vip;
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
            'last_daily_check' => $versionRepository->get('runner_last_check'),
            'last_failure' => $versionRepository->get('runner_last_fail'),
            'last_ok' => $versionRepository->get('runner_last_ok'),
            'state' => $versionRepository->get('runner_state'),
            'boot_id' => $versionRepository->get('runner_boot_id'),
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
            'secure' => true,
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
            $systemUpload ? null : resolveBaseUrl(),
            true
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
    $limitPercent = quotaLimitPercent($versionRepository);

    Response::json([
        'status' => 'ok',
        'data' => [
            'hard_fail' => $hardFail,
            'limit_percent' => $limitPercent,
        ],
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

    $limitRaw = $payload['limit_percent'] ?? null;
    $limitPercent = $limitRaw === null
        ? quotaLimitPercent($versionRepository)
        : AuthService::normalizeQuotaLimitPercent($limitRaw);
    if ($limitRaw !== null && $limitPercent === null) {
        Response::json([
            'status' => 'error',
            'message' => sprintf('limit_percent must be between %d and %d', AuthService::MIN_QUOTA_LIMIT_PERCENT, AuthService::MAX_QUOTA_LIMIT_PERCENT),
        ], 422);
    }

    $versionRepository->set('quota_hard_fail', $hardFail ? '1' : '0');
    $versionRepository->set('quota_limit_percent', (string) $limitPercent);

    Response::json([
        'status' => 'ok',
        'data' => [
            'hard_fail' => $hardFail,
            'limit_percent' => $limitPercent,
        ],
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
                'secure' => isset($host['secure']) ? (bool) (int) $host['secure'] : true,
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

$router->add('POST', '#^/admin/hosts/(\d+)/secure$#', function ($matches) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $secure = normalizeBoolean($payload['secure'] ?? null);
    if ($secure === null) {
        Response::json([
            'status' => 'error',
            'message' => 'secure must be boolean',
        ], 422);
    }

    $hostRepository->updateSecure($hostId, $secure);
    $logRepository->log($hostId, 'admin.host.secure', [
        'fqdn' => $host['fqdn'],
        'secure' => $secure,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => (int) $host['id'],
                'fqdn' => $host['fqdn'],
                'secure' => $secure,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\d+)/vip$#', function ($matches) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $vipRaw = $payload['vip'] ?? null;
    $vip = normalizeBoolean($vipRaw);
    if ($vip === null) {
        Response::json([
            'status' => 'error',
            'message' => 'vip must be boolean',
        ], 422);
    }

    $hostRepository->updateVip($hostId, $vip);
    $logRepository->log($hostId, 'admin.host.vip', [
        'fqdn' => $host['fqdn'],
        'vip' => $vip,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => (int) $host['id'],
                'fqdn' => $host['fqdn'],
                'vip' => $vip,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\d+)/insecure/enable$#', function ($matches) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    if (isset($host['secure']) && (bool) (int) $host['secure']) {
        Response::json([
            'status' => 'error',
            'message' => 'Host is secure; insecure window not applicable',
        ], 422);
    }

    $now = time();
    $currentEnabled = $host['insecure_enabled_until'] ?? null;
    $baseTs = $now;
    if (is_string($currentEnabled) && trim($currentEnabled) !== '') {
        $ts = strtotime($currentEnabled);
        if ($ts !== false && $ts > $now) {
            $baseTs = $ts;
        }
    }

    $minutesRaw = $payload['duration_minutes'] ?? null;
    if ($minutesRaw === null && isset($host['insecure_window_minutes'])) {
        $minutesRaw = $host['insecure_window_minutes'];
    }
    $minutes = (int) ($minutesRaw ?? AuthService::DEFAULT_INSECURE_WINDOW_MINUTES);
    if ($minutes < AuthService::MIN_INSECURE_WINDOW_MINUTES) {
        $minutes = AuthService::MIN_INSECURE_WINDOW_MINUTES;
    } elseif ($minutes > AuthService::MAX_INSECURE_WINDOW_MINUTES) {
        $minutes = AuthService::MAX_INSECURE_WINDOW_MINUTES;
    }

    $enabledUntil = gmdate(DATE_ATOM, $baseTs + ($minutes * 60));
    $hostRepository->updateInsecureWindows($hostId, $enabledUntil, null, $minutes);
    $logRepository->log($hostId, 'admin.host.insecure_enable', [
        'fqdn' => $host['fqdn'],
        'enabled_until' => $enabledUntil,
        'window_minutes' => $minutes,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'insecure_enabled_until' => $enabledUntil,
                'insecure_grace_until' => null,
                'insecure_window_minutes' => $minutes,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\d+)/insecure/disable$#', function ($matches) use ($hostRepository, $logRepository) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $hostRepository->updateInsecureWindows($hostId, null, null);
    $logRepository->log($hostId, 'admin.host.insecure_disable', [
        'fqdn' => $host['fqdn'],
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'insecure_enabled_until' => null,
                'insecure_grace_until' => null,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\d+)/ipv4$#', function ($matches) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    $hostId = (int) $matches[1];
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $forceRaw = $payload['force'] ?? null;
    $force = normalizeBoolean($forceRaw);
    if (!is_bool($force)) {
        Response::json([
            'status' => 'error',
            'message' => 'force must be boolean',
        ], 422);
    }

    $hostRepository->updateForceIpv4($hostId, $force);
    $logRepository->log($hostId, 'admin.host.force_ipv4', [
        'fqdn' => $host['fqdn'] ?? null,
        'force_ipv4' => $force,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'force_ipv4' => $force,
                'ip' => null,
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
    $hasCanonicalAuth = $service->hasCanonicalAuth();
    $seedReasons = [];
    if (!$hasCanonicalAuth) {
        $seedReasons[] = 'missing_auth';
    }

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
    $chatgpt = $chatGptUsageService->fetchLatest(false);
    $weekStart = gmdate('Y-m-d\T00:00:00\Z', strtotime('-6 days'));
    $weekEnd = gmdate(DATE_ATOM);
    $snapshot = $chatgpt['snapshot'] ?? null;
    $secondaryLimit = is_array($snapshot) && isset($snapshot['secondary_limit_seconds'])
        ? (int) $snapshot['secondary_limit_seconds']
        : null;
    $secondaryResetAfter = is_array($snapshot) && isset($snapshot['secondary_reset_after_seconds'])
        ? (int) $snapshot['secondary_reset_after_seconds']
        : null;
    if ($secondaryLimit !== null && $secondaryResetAfter !== null && $secondaryLimit > 0 && $secondaryResetAfter >= 0) {
        $windowUsed = max(0, $secondaryLimit - $secondaryResetAfter);
        $weekStartTs = time() - $windowUsed;
        $weekStart = gmdate(DATE_ATOM, $weekStartTs);
    }
    $monthStart = gmdate('Y-m-01\T00:00:00\Z');
    $monthEnd = gmdate('Y-m-01\T00:00:00\Z', strtotime('+1 month'));
    $dayStart = gmdate('Y-m-d\T00:00:00\Z');
    $dayEnd = gmdate('Y-m-d\T00:00:00\Z', strtotime('+1 day'));
    $tokensDay = $tokenUsageRepository->totalsForRange($dayStart, $dayEnd);
    $tokensMonth = $tokenUsageRepository->totalsForRange($monthStart, $monthEnd);
    $tokensWeek = $tokenUsageRepository->totalsForRange($weekStart, $weekEnd);
    $pricing = $pricingService->latestPricing('gpt-5.1', false);
    $dailyCost = $pricingService->calculateCost($pricing, $tokensDay);
    $monthlyCost = $pricingService->calculateCost($pricing, $tokensMonth);
    $weeklyCost = $pricingService->calculateCost($pricing, $tokensWeek);
    $quotaHardFail = $versionRepository->getFlag('quota_hard_fail', true);
    $quotaLimitPercent = quotaLimitPercent($versionRepository);

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
            'has_canonical_auth' => $hasCanonicalAuth,
            'seed_required' => count($seedReasons) > 0,
            'seed_reasons' => $seedReasons,
            'tokens' => $tokens,
            'tokens_day' => $tokensDay,
            'tokens_month' => $tokensMonth,
            'tokens_week' => $tokensWeek,
            'pricing' => $pricing,
            'pricing_day_cost' => $dailyCost,
            'pricing_month_cost' => $monthlyCost,
            'pricing_week_cost' => $weeklyCost,
            'chatgpt_usage' => $chatgpt['snapshot'] ?? null,
            'chatgpt_cached' => $chatgpt['cached'] ?? false,
            'chatgpt_next_eligible_at' => $chatgpt['next_eligible_at'] ?? null,
            'quota_hard_fail' => $quotaHardFail,
            'quota_limit_percent' => $quotaLimitPercent,
        ],
    ]);
});

$router->add('GET', '#^/admin/hosts$#', function () use ($hostRepository, $digestRepository, $tokenUsageRepository, $service, $hostUserRepository, $authPayloadRepository, $versionRepository) {
    requireAdminAccess();
    $service->pruneStaleHosts();

    $canonicalDigest = null;
    $canonicalPayloadId = $versionRepository->get('canonical_payload_id');
    if ($canonicalPayloadId !== null && ctype_digit((string) $canonicalPayloadId)) {
        $canonicalPayload = $authPayloadRepository->findByIdWithEntries((int) $canonicalPayloadId);
        if ($canonicalPayload !== null && isset($canonicalPayload['sha256'])) {
            $canonicalDigest = $canonicalPayload['sha256'];
        }
    }

    $hosts = $hostRepository->all();
    $digests = $digestRepository->byHostId();

    $items = [];
    foreach ($hosts as $host) {
        $normalizeTs = static function ($value): ?string {
            if ($value === null) {
                return null;
            }
            try {
                $dt = new DateTimeImmutable((string) $value);
                return $dt->format(DATE_ATOM);
            } catch (\Exception) {
                return is_string($value) ? $value : null;
            }
        };
        $hostDigests = $digests[$host['id']] ?? [];
        $items[] = [
            'id' => (int) $host['id'],
            'fqdn' => $host['fqdn'],
            'status' => $host['status'],
            'last_refresh' => $normalizeTs($host['last_refresh'] ?? null),
            'updated_at' => $normalizeTs($host['updated_at'] ?? null),
            'created_at' => $normalizeTs($host['created_at'] ?? null),
            'client_version' => $host['client_version'] ?? null,
            'wrapper_version' => $host['wrapper_version'] ?? null,
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
            'ip' => $host['ip'] ?? null,
            'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
            'secure' => isset($host['secure']) ? (bool) (int) $host['secure'] : true,
            'vip' => isset($host['vip']) ? (bool) (int) $host['vip'] : false,
            'insecure_enabled_until' => $normalizeTs($host['insecure_enabled_until'] ?? null),
            'insecure_grace_until' => $normalizeTs($host['insecure_grace_until'] ?? null),
            'insecure_window_minutes' => isset($host['insecure_window_minutes']) && $host['insecure_window_minutes'] !== null
                ? (int) $host['insecure_window_minutes']
                : null,
            'force_ipv4' => isset($host['force_ipv4']) ? (bool) (int) $host['force_ipv4'] : false,
            'canonical_digest' => $host['auth_digest'] ?? null,
            'recent_digests' => array_values(array_unique($hostDigests)),
            'authed' => ($host['auth_digest'] ?? '') !== '',
            'auth_outdated' => $canonicalDigest !== null
                && isset($host['auth_digest'])
                && (string) $host['auth_digest'] !== (string) $canonicalDigest,
            'token_usage' => $tokenUsageRepository->latestForHost((int) $host['id']),
            'users' => $hostUserRepository->listByHost((int) $host['id']),
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

$router->add('GET', '#^/admin/usage/ingests$#', function () use ($tokenUsageIngestRepository, $pricingService, $pricingModel) {
    requireAdminAccess();

    $page = resolveIntQuery('page') ?? 1;
    $perPage = resolveIntQuery('per_page') ?? 50;
    $hostId = resolveIntQuery('host_id');
    $query = isset($_GET['q']) && !is_array($_GET['q']) ? trim((string) $_GET['q']) : null;
    $sort = isset($_GET['sort']) && !is_array($_GET['sort']) ? (string) $_GET['sort'] : 'created_at';
    $direction = isset($_GET['direction']) && !is_array($_GET['direction']) ? (string) $_GET['direction'] : 'desc';

    $result = $tokenUsageIngestRepository->search($query, $hostId, $page, $perPage, $sort, $direction);
    $pricing = $pricingService->latestPricing($pricingModel, false);
    $currency = isset($pricing['currency']) && is_string($pricing['currency']) ? $pricing['currency'] : 'USD';
    $result['currency'] = $currency;

    Response::json([
        'status' => 'ok',
        'data' => $result,
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

$router->add('GET', '#^/admin/usage/cost-history$#', function () use ($costHistoryService) {
    requireAdminAccess();

    $days = resolveIntQuery('days') ?? 60;
    if ($days < 1) {
        $days = 60;
    }

    $history = $costHistoryService->history($days);

    Response::json([
        'status' => 'ok',
        'data' => $history,
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

$router->add('GET', '#^/admin/chatgpt/usage/history$#', function () use ($chatGptUsageService) {
    requireAdminAccess();
    $days = resolveIntQuery('days') ?? 60;
    if ($days < 1) {
        $days = 60;
    }

    $history = $chatGptUsageService->history($days);

    Response::json([
        'status' => 'ok',
        'data' => $history,
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

$router->add('GET', '#^/admin/config$#', function () use ($clientConfigService) {
    requireAdminAccess();
    $doc = $clientConfigService->adminFetch();

    Response::json([
        'status' => 'ok',
        'data' => $doc,
    ]);
});

$router->add('GET', '#^/admin/mcp/logs$#', function () use ($mcpAccessLogRepository) {
    requireAdminAccess();

    $limit = resolveIntQuery('limit') ?? 200;
    $logs = $mcpAccessLogRepository->recent($limit);

    Response::json([
        'status' => 'ok',
        'data' => [
            'logs' => $logs,
        ],
    ]);
});

$router->add('POST', '#^/admin/config/render$#', function () use ($payload, $clientConfigService) {
    requireAdminAccess();
    $settings = is_array($payload['settings'] ?? null) ? $payload['settings'] : [];
    $baseUrl = resolveBaseUrl();
    // For preview, inject managed MCP with a placeholder API key so the rendered output matches what hosts receive.
    $rendered = $clientConfigService->renderForHost($settings, null, $baseUrl, '<host api key>');

    Response::json([
        'status' => 'ok',
        'data' => $rendered,
    ]);
});

$router->add('POST', '#^/admin/config/store$#', function () use ($payload, $clientConfigService) {
    requireAdminAccess();

    try {
        $result = $clientConfigService->store(is_array($payload) ? $payload : [], null);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    }

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('GET', '#^/admin/agents$#', function () use ($agentsService) {
    requireAdminAccess();
    $doc = $agentsService->adminFetch();

    Response::json([
        'status' => 'ok',
        'data' => $doc,
    ]);
});

$router->add('POST', '#^/admin/agents/store$#', function () use ($payload, $agentsService) {
    requireAdminAccess();

    $content = '';
    if (is_array($payload)) {
        $content = (string) ($payload['content'] ?? ($payload['body'] ?? ''));
    }
    $sha = is_array($payload) ? ($payload['sha256'] ?? null) : null;

    try {
        $result = $agentsService->store($content, $sha, null);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    }

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('GET', '#^/admin/mcp/memories$#', function () use ($memoryService) {
    requireAdminAccess();

    $query = isset($_GET['q']) ? (string) $_GET['q'] : ((isset($_GET['query']) ? (string) $_GET['query'] : ''));
    $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
    $hostId = isset($_GET['host_id']) ? $_GET['host_id'] : null;
    $tagsRaw = $_GET['tags'] ?? '';
    $tags = [];
    if (is_string($tagsRaw) && trim($tagsRaw) !== '') {
        $tags = array_filter(array_map('trim', preg_split('/[,\s]+/', $tagsRaw)));
    }

    try {
        $result = $memoryService->adminSearch([
            'query' => $query,
            'limit' => $limit,
            'host_id' => $hostId,
            'tags' => $tags,
        ]);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    }

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('DELETE', '#^/admin/mcp/memories/(\\d+)$#', function ($matches) use ($memoryService) {
    requireAdminAccess();
    $id = (int) $matches[1];
    $result = $memoryService->adminDelete($id);

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

$router->add('POST', '#^/auth$#', function () use ($payload, $service, $chatGptUsageService, $versionRepository) {
    if ($versionRepository->getFlag('api_disabled', false)) {
        Response::json([
            'status' => 'error',
            'message' => 'API disabled by administrator',
        ], 503);
    }

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

$router->add('POST', '#^/agents/retrieve$#', function () use ($payload, $service, $agentsService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
    $result = $agentsService->retrieve($sha, $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/config/retrieve$#', function () use ($payload, $service, $clientConfigService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $baseUrl = resolveBaseUrl();

    $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
    $result = $clientConfigService->retrieve($sha, $host, $baseUrl, $apiKey);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/mcp/memories/store$#', function () use ($payload, $service, $memoryService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $result = $memoryService->store(is_array($payload) ? $payload : [], $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/mcp/memories/retrieve$#', function () use ($payload, $service, $memoryService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $result = $memoryService->retrieve(is_array($payload) ? $payload : [], $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/mcp/memories/search$#', function () use ($payload, $service, $memoryService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $result = $memoryService->search(is_array($payload) ? $payload : [], $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
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
        $data = $service->recordTokenUsage($host, is_array($payload) ? $payload : [], $clientIp);
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

// MCP streamable_http GET probe (spec requires GET handling; we only advertise POST).
$router->add('GET', '#^/mcp$#', function () {
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (!isOriginAllowed($origin)) {
        Response::json([
            'jsonrpc' => '2.0',
            'error' => ['code' => -32099, 'message' => 'Origin not allowed'],
            'id' => null,
        ], 403);
    }

    header('Allow: POST');
    Response::json([
        'status' => 'error',
        'message' => 'GET not supported for MCP stream; use POST JSON-RPC',
    ], 405);
});

// MCP streamable_http endpoint (single POST per JSON-RPC message).
$router->add('POST', '#^/mcp$#', function () use ($rawBody, $service, $memoryService, $mcpServer, $mcpAccessLogRepository) {
    // Authenticate but bypass IP binding for MCP (clients may roam while MCP still needs to work).
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();

    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if (!isOriginAllowed($origin)) {
        Response::json([
            'jsonrpc' => '2.0',
            'error' => ['code' => -32099, 'message' => 'Origin not allowed'],
            'id' => null,
        ], 403);
    }

    $host = $service->authenticate($apiKey, $clientIp, false);

    // Enforce insecure-host window the same way /auth does (extends window on access, denies when closed).
    $host = $service->enforceInsecureWindow($host, 'mcp');

    $decoded = json_decode($rawBody ?? '', true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        Response::json(['jsonrpc' => '2.0', 'error' => ['code' => -32700, 'message' => 'Parse error'], 'id' => null], 400);
    }

    $requests = [];
    $isBatch = false;
    if (is_array($decoded) && array_keys($decoded) === range(0, count($decoded) - 1)) {
        $isBatch = true;
        $requests = $decoded;
    } else {
        $requests = [$decoded];
    }

    $responses = [];

    foreach ($requests as $req) {
        if (!is_array($req) || ($req['jsonrpc'] ?? '') !== '2.0' || !isset($req['method'])) {
            $responses[] = [
                'jsonrpc' => '2.0',
                'error' => ['code' => -32600, 'message' => 'Invalid Request'],
                'id' => $req['id'] ?? null,
            ];
            continue;
        }

        $method = (string) $req['method'];
        $id = $req['id'] ?? null;
        $params = is_array($req['params'] ?? null) ? $req['params'] : [];
        $isNotification = $id === null;

        $result = null;
        $error = null;
        $toolError = false;

        switch ($method) {
            case 'initialize':
                $result = [
                    'protocolVersion' => '2025-03-26',
                    'capabilities' => [
                        'tools' => ['listChanged' => false],
                        'resources' => [
                            'subscribe' => false,
                            'listChanged' => false,
                        ],
                    ],
                    'serverInfo' => [
                        'name' => 'codex-coordinator',
                        'version' => $service->versionSummary()['wrapper_version'] ?? 'unknown',
                    ],
                ];
                break;

            case 'tools/list':
            case 'tools.list':
            case 'list_tools':
                $result = [
                    'tools' => $mcpServer->listTools(),
                ];
                break;

            case 'resources/templates/list':
            case 'resources.templates.list':
            case 'list_resource_templates':
                $result = [
                    'resourceTemplates' => $mcpServer->listResourceTemplates(),
                ];
                break;

            case 'resources/list':
            case 'resources.list':
            case 'list_resources':
                $result = [
                    'resources' => $mcpServer->listResources($host),
                ];
                break;

            case 'resources/read':
            case 'resources.read':
            case 'read_resource':
                $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                if ($uri === '') {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                    break;
                }
                try {
                    $result = $mcpServer->readResource($uri, $host);
                } catch (InvalidArgumentException $exception) {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                }
                break;

            case 'resources/create':
            case 'resources.create':
            case 'create_resource':
                $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                if ($uri === '') {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                    break;
                }
                try {
                    $result = $mcpServer->createResource($uri, $params, $host);
                } catch (InvalidArgumentException $exception) {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                }
                break;

            case 'resources/update':
            case 'resources.update':
            case 'update_resource':
                $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                if ($uri === '') {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                    break;
                }
                try {
                    $result = $mcpServer->updateResource($uri, $params, $host);
                } catch (InvalidArgumentException $exception) {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                }
                break;

            case 'resources/delete':
            case 'resources.delete':
            case 'delete_resource':
                $uri = is_string($params['uri'] ?? null) ? (string) $params['uri'] : '';
                if ($uri === '') {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => 'uri is required'];
                    break;
                }
                try {
                    $result = $mcpServer->deleteResource($uri, $host);
                } catch (InvalidArgumentException $exception) {
                    $error = ['code' => -32602, 'message' => 'Invalid params', 'data' => $exception->getMessage()];
                }
                break;

            case 'tools/call':
            case 'tools.call':
            case 'call_tool':
                $name = (string) ($params['name'] ?? '');
                $args = is_array($params['arguments'] ?? null) ? $params['arguments'] : [];
                if ($name === '') {
                    $result = $mcpServer->wrapContent('Tool name is required', true);
                    $toolError = true;
                    break;
                }

                try {
                    $result = $mcpServer->dispatch($name, $args, $host);
                } catch (McpToolNotFoundException $exception) {
                    $result = $mcpServer->wrapContent('Method not found: ' . $name, true);
                    $toolError = true;
                } catch (InvalidArgumentException $exception) {
                    $result = $mcpServer->wrapContent($exception->getMessage(), true);
                    $toolError = true;
                } catch (ValidationException $exception) {
                    $result = $mcpServer->wrapContent(json_encode($exception->getErrors(), JSON_UNESCAPED_SLASHES) ?: 'Invalid params', true);
                    $toolError = true;
                } catch (Throwable $exception) {
                    $result = $mcpServer->wrapContent('Internal error: ' . $exception->getMessage(), true);
                    $toolError = true;
                }
                break;

            default:
                $error = ['code' => -32601, 'message' => 'Method not found'];
        }

        // Log MCP access
        $mcpAccessLogRepository->log(
            $host['id'] ?? null,
            $clientIp,
            $method,
            isset($params['name']) ? (string) $params['name'] : (isset($params['uri']) ? (string) $params['uri'] : null),
            $error === null && !$toolError,
            $error['code'] ?? null,
            $error['message'] ?? null
        );

        if ($isNotification) {
            // No response for notifications.
            continue;
        }

        $response = ['jsonrpc' => '2.0', 'id' => $id];
        if ($error !== null) {
            $response['error'] = $error;
        } else {
            $response['result'] = $result;
        }
        $responses[] = $response;
    }

    if ($isBatch) {
        if (count($responses) === 0) {
            http_response_code(202);
            return;
        }
        header('Content-Type: application/json');
        echo json_encode($responses);
    } else {
        if (count($responses) === 0) {
            http_response_code(202);
            return;
        }
        header('Content-Type: application/json');
        echo json_encode($responses[0]);
    }
    exit;
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

function enforceGlobalRateLimit(?RateLimiter $rateLimiter, ?string $clientIp, string $method, string $path): void
{
    if ($rateLimiter === null || $clientIp === null || $clientIp === '') {
        return;
    }

    if (str_starts_with($path, '/admin')) {
        return;
    }

    $limit = (int) Config::get('RATE_LIMIT_GLOBAL_PER_MINUTE', 120);
    $windowSeconds = (int) Config::get('RATE_LIMIT_GLOBAL_WINDOW', 60);
    if ($limit <= 0 || $windowSeconds <= 0) {
        return;
    }

    $result = $rateLimiter->hit($clientIp, 'global', $limit, $windowSeconds);
    if ($result['allowed']) {
        return;
    }

    Response::json([
        'status' => 'error',
        'message' => 'Rate limit exceeded',
        'data' => [
            'bucket' => 'global',
            'reset_at' => $result['reset_at'],
            'limit' => $result['limit'],
        ],
    ], 429);
}

function resolveMtls(): array
{
    $required = isMtlsRequired();
    $fingerprint = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? '';
    $present = $fingerprint !== '';

    $meta = [
        'required' => $required,
        'present' => $present,
    ];

    if ($present) {
        $meta['fingerprint'] = $fingerprint;
        $meta['subject'] = $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? null;
        $meta['issuer'] = $_SERVER['HTTP_X_MTLS_ISSUER'] ?? null;
    }

    return $meta;
}

function normalizeOrigin(?string $origin): ?string
{
    if ($origin === null || $origin === '') {
        return null;
    }

    $parsed = parse_url($origin);
    if (!is_array($parsed) || !isset($parsed['scheme'], $parsed['host'])) {
        return null;
    }

    $normalized = strtolower((string) $parsed['scheme']) . '://' . strtolower((string) $parsed['host']);
    if (isset($parsed['port'])) {
        $normalized .= ':' . (int) $parsed['port'];
    }

    return $normalized;
}

function allowedOrigins(): array
{
    $origins = [];

    $configured = Config::get('MCP_ALLOWED_ORIGINS');
    if (is_string($configured) && trim($configured) !== '') {
        foreach (explode(',', $configured) as $piece) {
            $normalized = normalizeOrigin(trim($piece));
            if ($normalized !== null) {
                $origins[] = $normalized;
            }
        }
    }

    $base = Config::get('PUBLIC_BASE_URL');
    $baseOrigin = normalizeOrigin(is_string($base) ? $base : null);
    if ($baseOrigin !== null) {
        $origins[] = $baseOrigin;
    }

    $hostHeader = $_SERVER['HTTP_HOST'] ?? '';
    if ($hostHeader !== '') {
        $scheme = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off' ? 'https' : 'http');
        $requestOrigin = normalizeOrigin($scheme . '://' . $hostHeader);
        if ($requestOrigin !== null) {
            $origins[] = $requestOrigin;
        }
    }

    return array_values(array_unique($origins));
}

function isOriginAllowed(?string $origin): bool
{
    if ($origin === null || $origin === '') {
        return true;
    }

    $normalized = normalizeOrigin($origin);
    if ($normalized === null) {
        return false;
    }

    foreach (allowedOrigins() as $candidate) {
        if ($candidate === $normalized) {
            return true;
        }
    }

    return false;
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

function quotaLimitPercent(VersionRepository $versionRepository): int
{
    $raw = $versionRepository->get('quota_limit_percent');
    $normalized = AuthService::normalizeQuotaLimitPercent($raw);
    return $normalized ?? AuthService::DEFAULT_QUOTA_LIMIT_PERCENT;
}

function normalizeBaseUrlCandidate(string $value): string
{
    $trimmed = rtrim(trim($value), '/');
    if ($trimmed === '') {
        return '';
    }

    // Allow host + optional port and path; block whitespace/control chars.
    if (!preg_match('#^https?://[A-Za-z0-9._~:-]+(?:/.*)?$#', $trimmed)) {
        return '';
    }

    return $trimmed;
}

function resolveBaseUrl(): string
{
    $candidates = [];

    $envBase = Config::get('PUBLIC_BASE_URL', '');
    if (is_string($envBase) && trim($envBase) !== '') {
        $candidates[] = $envBase;
    }

    $forwardedHostHeader = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? '';
    $hostHeader = $_SERVER['HTTP_HOST'] ?? '';
    $hostCandidate = $forwardedHostHeader !== '' ? (explode(',', $forwardedHostHeader)[0] ?? '') : $hostHeader;
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

    if ($hostCandidate !== '') {
        $candidates[] = sprintf('%s://%s', $scheme, trim($hostCandidate));
    }

    $serverName = $_SERVER['SERVER_NAME'] ?? '';
    if ($serverName !== '' && $serverName !== $hostCandidate) {
        $candidates[] = sprintf('%s://%s', $scheme, $serverName);
    }

    foreach ($candidates as $candidate) {
        $normalized = normalizeBaseUrlCandidate($candidate);
        if ($normalized !== '') {
            return $normalized;
        }
    }

    return '';
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

    return normalizeBaseUrlCandidate($baseUrl);
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
    $forceIpv4 = isset($host['force_ipv4']) ? (bool) (int) $host['force_ipv4'] : false;
    $curl4 = $forceIpv4 ? '-4' : '';

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

CURL4="__CURL4__"
curl_fetch() {
  # Use IPv4 when requested; empty expansion otherwise.
  curl ${CURL4:+-4} "$@"
}

echo "Installing Codex for __FQDN__ via __BASE__"

curl_fetch -fsSL "__BASE__/wrapper/download" -H "X-API-Key: __API__" -o "$tmpdir/cdx"
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

curl_fetch -fsSL "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/${asset}" -o "$tmpdir/codex.tar.gz"
tar -xzf "$tmpdir/codex.tar.gz" -C "$tmpdir"
codex_bin="$(find "$tmpdir" -type f ! -name "*.tar.gz" \( -name "codex" -o -name "codex-*" \) | head -n1)"
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
        '__CURL4__' => $curl4,
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

function isMtlsRequired(): bool
{
    $value = Config::get('ADMIN_REQUIRE_MTLS', '1');
    $normalized = strtolower(trim((string) $value));

    return !in_array($normalized, ['0', 'false', 'off', 'no'], true);
}

function requireMtls(): void
{
    if (!isMtlsRequired()) {
        return;
    }

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
