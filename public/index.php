<?php

declare(strict_types=1);

use App\Config;
use App\Database;
use App\Exceptions\HttpException;
use App\Http\Response;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Services\AuthService;
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
$invitationKey = Config::get('INVITATION_KEY', '');
$service = new AuthService($hostRepository, $logRepository, $invitationKey);

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

    if ($method === 'POST' && $normalizedPath === '/auth/sync') {
        $apiKey = resolveApiKey();
        $host = $service->authenticate($apiKey);
        $incoming = extractAuthPayload($payload);

        $result = $service->sync($incoming, $host);

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
