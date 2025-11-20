<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Exceptions\HttpException;
use App\Http\Response;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\HostStatusExporter;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

$root = dirname(__DIR__);

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$dbPath = Config::get('DB_PATH', $root . '/storage/database.sqlite');
$database = new Database($dbPath);
$database->migrate();

$hostRepository = new HostRepository($database);
$digestRepository = new HostAuthDigestRepository($database);
$logRepository = new LogRepository($database);
$versionRepository = new VersionRepository($database);
$invitationKey = Config::get('INVITATION_KEY', '');
$statusPath = Config::get('STATUS_REPORT_PATH', $root . '/storage/host-status.txt');
$statusExporter = new HostStatusExporter($hostRepository, $statusPath);
$service = new AuthService($hostRepository, $digestRepository, $logRepository, $versionRepository, $invitationKey, $statusExporter);
unset($statusPath, $invitationKey);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$normalizedPath = rtrim($path, '/');
if ($normalizedPath === '') {
    $normalizedPath = '/';
}

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
        $available = $service->availableClientVersion();
        $reported = $service->latestReportedVersions();
        $service->seedWrapperVersionFromReported($reported['wrapper_version']);
        $published = $service->publishedVersions();

        $clientVersion = $available['version'] ?? $published['client_version'] ?? $reported['client_version'];
        $wrapperVersion = $published['wrapper_version'] ?? $reported['wrapper_version'];

        Response::json([
            'status' => 'ok',
            'data' => [
                'client_version' => $clientVersion,
                'client_version_checked_at' => $available['updated_at'],
                'wrapper_version' => $wrapperVersion,
                'reported_client_version' => $reported['client_version'],
                'reported_wrapper_version' => $reported['wrapper_version'],
            ],
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

        $published = $service->updatePublishedVersions($clientVersion, $wrapperVersion);
        $available = $service->availableClientVersion();
        $reported = $service->latestReportedVersions();

        $clientVersionOut = $available['version'] ?? $published['client_version'] ?? $reported['client_version'];
        $wrapperVersionOut = $published['wrapper_version'] ?? $reported['wrapper_version'];

        Response::json([
            'status' => 'ok',
            'data' => [
                'client_version' => $clientVersionOut,
                'client_version_checked_at' => $available['updated_at'],
                'wrapper_version' => $wrapperVersionOut,
                'reported_client_version' => $reported['client_version'],
                'reported_wrapper_version' => $reported['wrapper_version'],
            ],
        ]);
    }

    if ($method === 'POST' && $normalizedPath === '/auth') {
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

    // Admin-only, mTLS-gated routes.
    if ($method === 'GET' && $normalizedPath === '/admin/overview') {
        requireAdminAccess();

        $hosts = $hostRepository->all();
        $totalHosts = count($hosts);
        $activeHosts = count(array_filter($hosts, static fn (array $host) => ($host['status'] ?? '') === 'active'));
        $suspendedHosts = count(array_filter($hosts, static fn (array $host) => ($host['status'] ?? '') === 'suspended'));

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
            $days = max(0, ($now - $ts) / 86400);
            $refreshAges[] = $days;
        }

        $avgRefreshAgeDays = $refreshAges ? array_sum($refreshAges) / count($refreshAges) : null;

        $latestLog = $logRepository->latestCreatedAt();
        $versions = $service->versionSummary();

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
                    'suspended' => $suspendedHosts,
                ],
                'avg_refresh_age_days' => $avgRefreshAgeDays,
                'latest_log_at' => $latestLog,
                'versions' => $versions,
                'mtls' => $mtlsContext,
            ],
        ]);
    }

    if ($method === 'GET' && $normalizedPath === '/admin/hosts') {
        requireAdminAccess();

        $hosts = $hostRepository->all();
        $items = [];

        foreach ($hosts as $host) {
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
                'canonical_digest' => $host['auth_digest'] ?? null,
                'recent_digests' => $digestRepository->recentDigests((int) $host['id']),
            ];
        }

        Response::json([
            'status' => 'ok',
            'data' => [
                'hosts' => $items,
            ],
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
        $authJson = $host['auth_json'] ?? null;
        $auth = null;
        if ($includeBody && $authJson) {
            $decoded = json_decode($authJson, true);
            if (json_last_error() === JSON_ERROR_NONE) {
                $auth = $decoded;
            }
        }

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => (int) $host['id'],
                    'fqdn' => $host['fqdn'],
                    'status' => $host['status'],
                    'last_refresh' => $host['last_refresh'] ?? null,
                    'updated_at' => $host['updated_at'] ?? null,
                    'client_version' => $host['client_version'] ?? null,
                    'wrapper_version' => $host['wrapper_version'] ?? null,
                    'ip' => $host['ip'] ?? null,
                ],
                'canonical_last_refresh' => $host['last_refresh'] ?? null,
                'canonical_digest' => $host['auth_digest'] ?? null,
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

        $hostRepository->deleteById($hostId);
        $logRepository->log($hostId, 'admin.host.delete', ['fqdn' => $host['fqdn']]);

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
