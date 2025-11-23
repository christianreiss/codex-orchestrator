<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Exceptions\HttpException;
use App\Http\Response;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\WrapperService;
use App\Services\RunnerVerifier;
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
$database = new Database($dbConfig);
$database->migrate();

$hostRepository = new HostRepository($database);
$hostStateRepository = new HostAuthStateRepository($database);
$digestRepository = new HostAuthDigestRepository($database);
$authEntryRepository = new AuthEntryRepository($database);
$authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository);
$logRepository = new LogRepository($database);
$tokenUsageRepository = new TokenUsageRepository($database);
$versionRepository = new VersionRepository($database);
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
$invitationKey = Config::get('INVITATION_KEY', '');
$service = new AuthService($hostRepository, $authPayloadRepository, $hostStateRepository, $digestRepository, $logRepository, $tokenUsageRepository, $versionRepository, $invitationKey, $wrapperService, $runnerVerifier);
$wrapperService->ensureSeeded();
unset($invitationKey);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
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

try {
    if ($method === 'POST' && $normalizedPath === '/register') {
        $result = $service->register(
            trim((string) ($payload['fqdn'] ?? '')),
            (string) ($payload['invitation_key'] ?? '')
        );

        Response::json([
            'status' => 'ok',
            'host' => $result,
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/versions') {
        $versions = $service->versionSummary();

        Response::json([
            'status' => 'ok',
            'data' => $versions,
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/versions') {
        $adminKey = resolveAdminKey();
        if (!hash_equals(Config::get('VERSION_ADMIN_KEY', ''), $adminKey ?? '')) {
            Response::json([
                'status' => 'error',
                'message' => 'Admin key required',
            ], 401);
        }

        $clientVersion = normalizeVersionValue($payload['client_version'] ?? null);
        $wrapperVersion = normalizeVersionValue($payload['wrapper_version'] ?? null);

        if ($clientVersion === null && $wrapperVersion === null) {
            Response::json([
                'status' => 'error',
                'message' => 'At least one of client_version or wrapper_version is required',
            ], 422);
        }

        $service->updatePublishedVersions($clientVersion, $wrapperVersion);
        $versions = $service->versionSummary();

        Response::json([
            'status' => 'ok',
            'data' => $versions,
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/wrapper') {
        $adminKey = resolveAdminKey();
        if (!hash_equals(Config::get('VERSION_ADMIN_KEY', ''), $adminKey ?? '')) {
            Response::json([
                'status' => 'error',
                'message' => 'Admin key required',
            ], 401);
        }

        if (!isset($_FILES['file']) || !is_array($_FILES['file']) || ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
            Response::json([
                'status' => 'error',
                'message' => 'file is required (multipart/form-data)',
            ], 422);
        }

        $version = normalizeVersionValue($_POST['version'] ?? null);
        if ($version === null) {
            Response::json([
                'status' => 'error',
                'message' => 'version is required',
            ], 422);
        }

        $expectedSha = normalizeVersionValue($_POST['sha256'] ?? null);

        try {
            $meta = $wrapperService->replaceFromUpload(
                (string) $_FILES['file']['tmp_name'],
                $version,
                $expectedSha,
                true
            );
        } catch (Throwable $exception) {
            Response::json([
                'status' => 'error',
                'message' => $exception->getMessage(),
            ], 422);
        }

        Response::json([
            'status' => 'ok',
            'data' => $meta,
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/wrapper') {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $service->authenticate($apiKey, $clientIp);

        $meta = $wrapperService->metadata();
        if ($meta['url'] === null || $meta['version'] === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Wrapper not available',
            ], 404);
        }

        Response::json([
            'status' => 'ok',
            'data' => $meta,
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/wrapper/download') {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $service->authenticate($apiKey, $clientIp);

        $meta = $wrapperService->metadata();
        $pathToFile = $wrapperService->contentPath();
        if ($meta['version'] === null || !is_file($pathToFile)) {
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
        $size = $meta['size_bytes'];
        if ($size !== null) {
            header('Content-Length: ' . $size);
        }
        readfile($pathToFile);
        exit;
    }

    if ($method === 'POST' && $normalizedPath === '/auth') {
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

        $result = $service->handleAuth(is_array($payload) ? $payload : [], $host, $clientVersion, $wrapperVersion);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/usage') {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $service->authenticate($apiKey, $clientIp);

        $result = $service->recordTokenUsage($host, is_array($payload) ? $payload : []);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    if ($method === 'DELETE' && $normalizedPath === '/auth') {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $forceDelete = ($_GET['force'] ?? '') === '1' || ($_SERVER['HTTP_X_CODEX_SELF_DESTRUCT'] ?? '') === '1';
        $host = $service->authenticate($apiKey, $clientIp, $forceDelete);

        $result = $service->deleteHost($host);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    // Admin-only, mTLS-gated routes.
    if ($method === 'GET' && $normalizedPath === '/admin/overview') {
        requireAdminAccess();

        $hosts = $hostRepository->all();
        $totalHosts = count($hosts);
        $activeHosts = count(array_filter($hosts, static fn (array $host) => ($host['status'] ?? '') === 'active'));

        $refreshAges = [];
        $now = time();
        foreach ($hosts as $h) {
            $lr = $h['last_refresh'] ?? null;
            if (!$lr) {
                continue;
            }
            $ts = strtotime($lr);
            if ($ts === false) {
                continue;
            }
            if ($ts < MIN_LAST_REFRESH_EPOCH) {
                continue;
            }
            $days = max(0, ($now - $ts) / 86400);
            $refreshAges[] = $days;
        }

        $avgRefreshAgeDays = $refreshAges ? array_sum($refreshAges) / count($refreshAges) : null;

        $latestLog = $logRepository->latestCreatedAt();
        $versions = $service->versionSummary();
        $tokenTotals = $tokenUsageRepository->totals();
        $topToken = $tokenUsageRepository->topHost();

        $mtlsContext = [
            'subject' => $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? null,
            'issuer' => $_SERVER['HTTP_X_MTLS_ISSUER'] ?? null,
            'serial' => $_SERVER['HTTP_X_MTLS_SERIAL'] ?? null,
            'fingerprint' => $_SERVER['HTTP_X_MTLS_PRESENT'] ?? null,
        ];

        Response::json([
            'status' => 'ok',
            'data' => [
                'totals' => [
                    'hosts' => $totalHosts,
                    'active' => $activeHosts,
                ],
                'avg_refresh_age_days' => $avgRefreshAgeDays,
                'latest_log_at' => $latestLog,
                'versions' => $versions,
                'tokens' => [
                    'total' => $tokenTotals['total'],
                    'input' => $tokenTotals['input'],
                    'output' => $tokenTotals['output'],
                    'cached' => $tokenTotals['cached'],
                    'events' => $tokenTotals['events'],
                    'top_host' => $topToken ? [
                        'id' => $topToken['host_id'],
                        'fqdn' => $topToken['fqdn'],
                        'total' => $topToken['total'],
                    ] : null,
                ],
                'mtls' => $mtlsContext,
            ],
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/admin/versions/check') {
        requireAdminAccess();

        // Force refresh the available client version from upstream
        $available = $service->availableClientVersion(true);
        $versions = $service->versionSummary();

        Response::json([
            'status' => 'ok',
            'data' => [
                'available' => $available,
                'versions' => $versions,
            ],
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/admin/hosts') {
        requireAdminAccess();

        $hosts = $hostRepository->all();
        $tokenTotalsByHost = $tokenUsageRepository->totalsByHost();
        $items = [];

        foreach ($hosts as $host) {
            $hostId = (int) $host['id'];
            $state = $hostStateRepository->findByHostId($hostId);
            $usageTotals = $tokenTotalsByHost[$hostId] ?? null;

            $items[] = [
                'id' => $hostId,
                'fqdn' => $host['fqdn'],
                'status' => $host['status'],
                'last_refresh' => $host['last_refresh'] ?? null,
                'updated_at' => $host['updated_at'] ?? null,
                'client_version' => $host['client_version'] ?? null,
                'wrapper_version' => $host['wrapper_version'] ?? null,
                'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
                'ip' => $host['ip'] ?? null,
                'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
                'canonical_digest' => $state['seen_digest'] ?? ($host['auth_digest'] ?? null),
                'authed' => ($state['seen_digest'] ?? null) !== null
                    && ($host['auth_digest'] ?? null) !== null
                    && ($state['seen_digest'] === $host['auth_digest']),
                'recent_digests' => $digestRepository->recentDigests((int) $host['id']),
                'token_usage' => $usageTotals ? [
                    'total' => $usageTotals['total'],
                    'input' => $usageTotals['input'],
                    'output' => $usageTotals['output'],
                    'cached' => $usageTotals['cached'],
                    'events' => $usageTotals['events'],
                ] : null,
            ];
        }

        Response::json([
            'status' => 'ok',
            'data' => [
                'hosts' => $items,
            ],
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/admin/hosts/register') {
        requireAdminAccess();

        $fqdn = trim((string) ($payload['fqdn'] ?? ''));
        if ($fqdn === '') {
            Response::json([
                'status' => 'error',
                'message' => 'fqdn is required',
            ], 422);
        }

        // Reuse invitation-gated registration with the server's configured key.
        $host = $service->register($fqdn, Config::get('INVITATION_KEY', ''));

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => $host,
            ],
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/admin/runner') {
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
            if (is_array($detailsRaw)) {
                $details = $detailsRaw;
            } elseif (is_string($detailsRaw) && $detailsRaw !== '') {
                $decoded = json_decode($detailsRaw, true);
                if (is_array($decoded)) {
                    $details = $decoded;
                }
            }
            $hostId = isset($row['host_id']) ? (int) $row['host_id'] : null;
            $host = $hostId ? $hostRepository->findById($hostId) : null;

            return [
                'id' => (int) $row['id'],
                'created_at' => $row['created_at'] ?? null,
                'host' => $host ? [
                    'id' => (int) $host['id'],
                    'fqdn' => $host['fqdn'],
                ] : null,
                'status' => $details['status'] ?? null,
                'reason' => $details['reason'] ?? null,
                'latency_ms' => isset($details['latency_ms']) ? (int) $details['latency_ms'] : null,
                'digest' => $details['incoming_digest'] ?? null,
                'last_refresh' => $details['incoming_last_refresh'] ?? null,
            ];
        };

        Response::json([
            'status' => 'ok',
            'data' => [
                'enabled' => $enabled,
                'runner_url' => $runnerUrl,
                'base_url' => $defaultBaseUrl,
                'timeout_seconds' => $timeoutSeconds,
                'last_daily_check' => $versionRepository->get('runner_last_check', null),
                'counts' => [
                    'validations_24h' => $logRepository->countActionsSince(['auth.validate'], $since),
                    'runner_store_24h' => $logRepository->countActionsSince(['auth.runner_store'], $since),
                ],
                'latest_validation' => $formatLog($latestValidationRow[0] ?? null),
                'latest_runner_store' => $formatLog($latestRunnerStoreRow[0] ?? null),
            ],
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/admin/api/state') {
        requireAdminAccess();

        $disabled = $versionRepository->getFlag('api_disabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/admin/api/state') {
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
    }

    if ($method === 'GET' && preg_match('#^/admin/hosts/(\d+)/auth$#', $normalizedPath, $matches)) {
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

        $auth = null;
        if ($includeBody && $payloadRow) {
            if (!empty($payloadRow['body']) && is_string($payloadRow['body'])) {
                $decoded = json_decode($payloadRow['body'], true);
                if (is_array($decoded)) {
                    $auth = $decoded;
                }
            }
            if ($auth === null) {
                // Fallback to reconstructed auth from entries.
                $auths = [];
                foreach ($payloadRow['entries'] ?? [] as $entry) {
                    $item = ['token' => $entry['token']];
                    if (!empty($entry['token_type'])) {
                        $item['token_type'] = $entry['token_type'];
                    }
                    if (!empty($entry['organization'])) {
                        $item['organization'] = $entry['organization'];
                    }
                    if (!empty($entry['project'])) {
                        $item['project'] = $entry['project'];
                    }
                    if (!empty($entry['api_base'])) {
                        $item['api_base'] = $entry['api_base'];
                    }
                    if (!empty($entry['meta']) && is_array($entry['meta'])) {
                        foreach ($entry['meta'] as $k => $v) {
                            $item[$k] = $v;
                        }
                    }
                    ksort($item);
                    $auths[$entry['target']] = $item;
                }
                ksort($auths);
                $auth = [
                    'last_refresh' => $payloadRow['last_refresh'] ?? null,
                    'auths' => $auths,
                ];
            }
        }

        $canonicalLastRefresh = $payloadRow['last_refresh']
            ?? ($host['last_refresh'] ?? ($state['seen_at'] ?? null));
        $canonicalDigest = $payloadRow['sha256']
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
    }

    if ($method === 'DELETE' && preg_match('#^/admin/hosts/(\d+)$#', $normalizedPath, $matches)) {
        requireAdminAccess();
        $hostId = (int) $matches[1];
        $host = $hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        // Log before delete so the FK can null out the host_id when the row is removed.
        $logRepository->log($hostId, 'admin.host.delete', ['fqdn' => $host['fqdn']]);
        $hostRepository->deleteById($hostId);

        Response::json([
            'status' => 'ok',
            'data' => ['deleted' => $hostId],
        ]);
    }

    if ($method === 'POST' && preg_match('#^/admin/hosts/(\d+)/clear$#', $normalizedPath, $matches)) {
        requireAdminAccess();
        $hostId = (int) $matches[1];
        $host = $hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $hostRepository->clearIp($hostId);
        $digestRepository->deleteByHostId($hostId);
        $logRepository->log($hostId, 'admin.host.clear', ['fqdn' => $host['fqdn']]);

        Response::json([
            'status' => 'ok',
            'data' => ['cleared' => $hostId],
        ]);
    }

    if ($method === 'POST' && preg_match('#^/admin/hosts/(\d+)/roaming$#', $normalizedPath, $matches)) {
        requireAdminAccess();
        $hostId = (int) $matches[1];
        $host = $hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $rawAllow = $payload['allow'] ?? ($payload['allow_roaming_ips'] ?? null);
        $allow = normalizeBoolean($rawAllow);
        if ($allow === null) {
            Response::json([
                'status' => 'error',
                'message' => 'allow must be a boolean',
            ], 422);
        }

        $hostRepository->updateAllowRoaming($hostId, $allow);
        $logRepository->log($hostId, 'admin.host.roaming', [
            'fqdn' => $host['fqdn'],
            'allow_roaming_ips' => $allow,
        ]);

        $updated = $hostRepository->findById($hostId) ?? $host;

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => (int) $updated['id'],
                    'fqdn' => $updated['fqdn'],
                    'allow_roaming_ips' => isset($updated['allow_roaming_ips']) ? (bool) (int) $updated['allow_roaming_ips'] : false,
                ],
            ],
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/admin/logs') {
        requireAdminAccess();

        $limit = resolveIntQuery('limit') ?? 50;
        $hostFilter = resolveIntQuery('host_id');
        $rows = $logRepository->recent($limit, $hostFilter);

        $logs = [];
        foreach ($rows as $row) {
            $details = $row['details'] ?? null;
            if (is_string($details)) {
                $decoded = json_decode($details, true);
                if (json_last_error() === JSON_ERROR_NONE) {
                    $details = $decoded;
                }
            }

            $logs[] = [
                'id' => (int) $row['id'],
                'host_id' => $row['host_id'] !== null ? (int) $row['host_id'] : null,
                'action' => $row['action'],
                'details' => $details,
                'created_at' => $row['created_at'],
            ];
        }

        Response::json([
            'status' => 'ok',
            'data' => [
                'logs' => $logs,
            ],
        ]);
    }

    Response::json([
        'status' => 'error',
        'message' => 'Not found',
    ], 404);
} catch (HttpException $exception) {
    $response = [
        'status' => 'error',
        'message' => $exception->getMessage(),
    ];

    if ($exception->context()) {
        $response['details'] = $exception->context();
    }

    Response::json($response, $exception->statusCode());
} catch (Throwable $exception) {
    Response::json([
        'status' => 'error',
        'message' => 'Unexpected server error',
    ], 500);
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

function resolveClientIp(): ?string
{
    // Preserve client IP even when behind simple reverse proxies that forward the address.
    $headers = ['HTTP_X_FORWARDED_FOR', 'HTTP_X_REAL_IP'];
    foreach ($headers as $header) {
        $value = $_SERVER[$header] ?? null;
        if ($value) {
            // X-Forwarded-For may contain a list; take the first non-empty token.
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

    $aliases = ['wrapper_version', 'cdx_wrapper_version'];
    foreach ($aliases as $alias) {
        $fromQuery = resolveQueryParam($alias);
        if ($fromQuery !== null) {
            return $fromQuery;
        }
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

    $fromQuery = resolveQueryParam('admin_key');
    if ($fromQuery !== null) {
        return $fromQuery;
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
