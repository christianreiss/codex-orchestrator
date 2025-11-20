<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Exceptions\HttpException;
use App\Http\Response;
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
$logRepository = new LogRepository($database);
$versionRepository = new VersionRepository($database);
$invitationKey = Config::get('INVITATION_KEY', '');
$statusPath = Config::get('STATUS_REPORT_PATH', $root . '/storage/host-status.txt');
$statusExporter = new HostStatusExporter($hostRepository, $statusPath);
$service = new AuthService($hostRepository, $logRepository, $versionRepository, $invitationKey, $statusExporter);

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

if ($method === 'POST' && $normalizedPath === '/auth/check') {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $clientVersion = extractClientVersion($payload);
    $wrapperVersion = extractWrapperVersion($payload);
    $metadata = extractAuthMetadata($payload);

    $result = $service->checkAuth($metadata, $host, $clientVersion, $wrapperVersion);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
}

if ($method === 'POST' && ($normalizedPath === '/auth/sync' || $normalizedPath === '/auth/update')) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $incoming = extractAuthPayload($payload);
    $clientVersion = extractClientVersion($payload);
        $wrapperVersion = extractWrapperVersion($payload);

        $result = $service->sync($incoming, $host, $clientVersion, $wrapperVersion);

        Response::json([
            'status' => 'ok',
            'data' => $result,
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

function extractAuthPayload(mixed $payload): array
{
    if (is_array($payload) && array_key_exists('auth', $payload) && is_array($payload['auth'])) {
        return $payload['auth'];
    }

    if (is_array($payload) && array_key_exists('last_refresh', $payload)) {
        return $payload;
    }

    return [];
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

function extractAuthMetadata(mixed $payload): array
{
    if (!is_array($payload)) {
        return [];
    }

    $metadata = [];

    if (array_key_exists('last_refresh', $payload) && is_string($payload['last_refresh'])) {
        $value = trim($payload['last_refresh']);
        if ($value !== '') {
            $metadata['last_refresh'] = $value;
        }
    }

    $hashKeys = ['auth_sha', 'auth_digest', 'digest'];
    foreach ($hashKeys as $key) {
        if (!array_key_exists($key, $payload)) {
            continue;
        }

        $value = normalizeVersionValue($payload[$key]);
        if ($value !== null) {
            $metadata['auth_sha'] = strtolower($value);
            break;
        }
    }

    return $metadata;
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
