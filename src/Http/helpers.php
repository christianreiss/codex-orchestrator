<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

use App\Config;
use App\Http\ClientIp;
use App\Http\Response;
use App\Http\TrustedProxy;
use App\Repositories\VersionRepository;
use App\Security\RateLimiter;
use App\Services\AdminAuthService;
use App\Services\AuthService;

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
    $fingerprintRaw = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? ($_SERVER['HTTP_X_MTLS_PRESENT'] ?? '');
    $fingerprint = is_string($fingerprintRaw) ? preg_replace('/[^A-Fa-f0-9]/', '', $fingerprintRaw) : '';
    // Accept colon/dash separated or bare hex; treat as present if we have >=64 hex chars.
    $present = is_string($fingerprint) && strlen($fingerprint) >= 64 && preg_match('/^[A-Fa-f0-9]+$/', $fingerprint) === 1;

    $meta = [
        'required' => $required,
        'present' => $present,
        'enforced' => $required && $present,
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

    $allowRequestHostOrigin = normalizeBoolean(Config::get('MCP_ALLOW_REQUEST_HOST_ORIGIN', '0')) ?? false;
    if ($allowRequestHostOrigin) {
        $requestOrigin = resolveRequestOrigin();
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
    return \App\Http\ClientIp::fromServer($_SERVER);
}

/**
 * @return array{command:string,last_refresh:string,digest:string,installation_id?:string}
 */
function extractSyncAuthFingerprint(mixed $payload): array
{
    $defaultDigest = hash('sha256', '{"last_refresh":"2000-01-01T00:00:00Z","auths":{}}');
    $authPayload = [];
    if (is_array($payload) && isset($payload['auth']) && is_array($payload['auth'])) {
        $authPayload = $payload['auth'];
    } elseif (is_array($payload)) {
        $authPayload = $payload;
    }

    $lastRefresh = '2000-01-01T00:00:00Z';
    if (isset($authPayload['last_refresh']) && is_string($authPayload['last_refresh']) && trim($authPayload['last_refresh']) !== '') {
        $lastRefresh = trim($authPayload['last_refresh']);
    }

    $digest = $defaultDigest;
    if (isset($authPayload['digest']) && is_string($authPayload['digest'])) {
        $candidate = strtolower(trim($authPayload['digest']));
        if (preg_match('/^[a-f0-9]{64}$/', $candidate) === 1) {
            $digest = $candidate;
        }
    }

    $result = [
        'command' => 'retrieve',
        'last_refresh' => $lastRefresh,
        'digest' => $digest,
    ];

    if (
        is_array($payload)
        && array_key_exists('installation_id', $payload)
        && is_string($payload['installation_id'])
        && trim($payload['installation_id']) !== ''
    ) {
        $result['installation_id'] = trim((string) $payload['installation_id']);
    }

    return $result;
}

function extractSyncAuthCandidate(mixed $payload): ?array
{
    if (!is_array($payload)) {
        return null;
    }

    if (isset($payload['auth_candidate']) && is_array($payload['auth_candidate'])) {
        return $payload['auth_candidate'];
    }

    return null;
}

/**
 * @return array{username:?string,hostname:?string}
 */
function extractSyncHostUserInput(mixed $payload): array
{
    $source = [];
    if (is_array($payload) && isset($payload['host_user']) && is_array($payload['host_user'])) {
        $source = $payload['host_user'];
    } elseif (is_array($payload)) {
        $source = $payload;
    }

    $username = null;
    if (isset($source['username']) && is_string($source['username']) && trim($source['username']) !== '') {
        $username = trim($source['username']);
    }

    $hostname = null;
    if (isset($source['hostname']) && is_string($source['hostname']) && trim($source['hostname']) !== '') {
        $hostname = trim($source['hostname']);
    }

    return [
        'username' => $username,
        'hostname' => $hostname,
    ];
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

function normalizeReverseDnsModeInput(mixed $value): ?string
{
    if ($value === null) {
        return 'global';
    }
    if (is_bool($value)) {
        return $value ? 'enabled' : 'disabled';
    }
    if (is_int($value)) {
        return $value !== 0 ? 'enabled' : 'disabled';
    }
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if ($normalized === '' || $normalized === 'global' || $normalized === 'default') {
            return 'global';
        }
        if (in_array($normalized, ['1', 'true', 'yes', 'on', 'enabled', 'enable'], true)) {
            return 'enabled';
        }
        if (in_array($normalized, ['0', 'false', 'no', 'off', 'disabled', 'disable'], true)) {
            return 'disabled';
        }
    }

    return null;
}

function formatReverseDnsModeOutput(mixed $value): string
{
    if ($value === null) {
        return 'global';
    }
    if (is_bool($value)) {
        return $value ? 'enabled' : 'disabled';
    }
    if (is_int($value)) {
        return $value !== 0 ? 'enabled' : 'disabled';
    }
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if ($normalized === 'enabled' || $normalized === 'disabled' || $normalized === 'global') {
            return $normalized;
        }
        if ($normalized === '1' || $normalized === 'true' || $normalized === 'yes' || $normalized === 'on') {
            return 'enabled';
        }
        if ($normalized === '0' || $normalized === 'false' || $normalized === 'no' || $normalized === 'off') {
            return 'disabled';
        }
    }

    return 'global';
}

function quotaLimitPercent(VersionRepository $versionRepository): int
{
    $raw = $versionRepository->get('quota_limit_percent');
    $normalized = AuthService::normalizeQuotaLimitPercent($raw);
    return $normalized ?? AuthService::DEFAULT_QUOTA_LIMIT_PERCENT;
}

function quotaWeekPartition(VersionRepository $versionRepository): int
{
    $raw = $versionRepository->get('quota_week_partition');
    $normalized = AuthService::normalizeQuotaWeekPartition($raw);
    return $normalized ?? AuthService::DEFAULT_QUOTA_WEEK_PARTITION;
}

function modelUsesSparkQuotaLane(?string $model): ?bool
{
    if (!is_string($model)) {
        return null;
    }

    $trimmed = strtolower(trim($model));
    if ($trimmed === '') {
        return null;
    }

    return str_contains($trimmed, 'spark');
}

function resolveActiveQuotaLaneForHost(array $host, VersionRepository $versionRepository, mixed $fallback = null): string
{
    $hostLanePreference = AuthService::normalizeQuotaLane($host['lane_preference'] ?? null);
    if ($hostLanePreference !== null) {
        return $hostLanePreference;
    }

    $hostModelSpark = modelUsesSparkQuotaLane($host['model_override'] ?? null);
    if ($hostModelSpark !== null) {
        return $hostModelSpark ? 'spark' : 'normal';
    }

    $globalModelSpark = modelUsesSparkQuotaLane($versionRepository->get('cdx_model'));
    if ($globalModelSpark !== null) {
        return $globalModelSpark ? 'spark' : 'normal';
    }

    $fallbackLane = AuthService::normalizeQuotaLane($fallback);
    if ($fallbackLane !== null) {
        return $fallbackLane;
    }

    return 'normal';
}

function inactivityWindowDays(VersionRepository $versionRepository): int
{
    $stored = $versionRepository->get('inactivity_window_days');
    if (is_numeric($stored)) {
        $value = (int) $stored;
    } else {
        $raw = Config::get('INACTIVITY_WINDOW_DAYS', 30);
        $value = is_numeric($raw) ? (int) $raw : 30;
    }

    if ($value < 0) {
        $value = 0;
    } elseif ($value > 60) {
        $value = 60;
    }

    return $value;
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

    $hostCandidate = resolveRequestHost();
    $scheme = resolveRequestScheme();

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

function runtimeEnvironment(): string
{
    $raw = Config::get('APP_ENV', 'development');
    if (!is_string($raw)) {
        return 'development';
    }

    $normalized = strtolower(trim($raw));
    if ($normalized === 'prod') {
        return 'production';
    }

    return $normalized !== '' ? $normalized : 'development';
}

function isProductionEnvironment(): bool
{
    return runtimeEnvironment() === 'production';
}

function publicBaseUrlRequired(): bool
{
    $default = isProductionEnvironment();
    $value = normalizeBoolean(Config::get('PUBLIC_BASE_URL_REQUIRED', $default ? '1' : '0'));
    return $value ?? $default;
}

function strictHostValidationEnabled(): bool
{
    $default = isProductionEnvironment();
    $value = normalizeBoolean(Config::get('STRICT_HOST_VALIDATION', $default ? '1' : '0'));
    return $value ?? $default;
}

function enforcePublicBaseUrlPolicy(string $path): void
{
    $publicBase = normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''));
    if (publicBaseUrlRequired() && $publicBase === '') {
        Response::json([
            'status' => 'error',
            'message' => 'PUBLIC_BASE_URL is required in this environment',
            'data' => [
                'app_env' => runtimeEnvironment(),
                'required' => true,
            ],
        ], 503);
    }

    if (!strictHostValidationEnabled() || $publicBase === '' || isHostValidationBypassPath($path)) {
        return;
    }

    if (!requestHostMatchesPublicBaseUrl($publicBase)) {
        Response::json([
            'status' => 'error',
            'message' => 'Request host does not match PUBLIC_BASE_URL',
            'data' => [
                'expected' => parse_url($publicBase, PHP_URL_HOST),
                'received' => parse_url('http://' . resolveRequestHost(), PHP_URL_HOST),
            ],
        ], 400);
    }
}

function isHostValidationBypassPath(string $path): bool
{
    if (str_starts_with($path, '/install/')) {
        return true;
    }
    if (str_starts_with($path, '/seed/auth/')) {
        return true;
    }

    return false;
}

function requestHostMatchesPublicBaseUrl(string $publicBase): bool
{
    $expectedHost = parse_url($publicBase, PHP_URL_HOST);
    if (!is_string($expectedHost) || trim($expectedHost) === '') {
        return true;
    }

    $expectedPortRaw = parse_url($publicBase, PHP_URL_PORT);
    $expectedScheme = parse_url($publicBase, PHP_URL_SCHEME);
    $expectedPort = is_int($expectedPortRaw)
        ? $expectedPortRaw
        : (strtolower((string) $expectedScheme) === 'https' ? 443 : 80);

    $requestHost = resolveRequestHost();
    if ($requestHost === '') {
        return false;
    }

    $parsed = parse_url('http://' . $requestHost);
    if (!is_array($parsed) || !isset($parsed['host'])) {
        return false;
    }

    $requestPort = isset($parsed['port']) && is_numeric($parsed['port'])
        ? (int) $parsed['port']
        : (resolveRequestScheme() === 'https' ? 443 : 80);

    if (strtolower((string) $parsed['host']) !== strtolower($expectedHost)) {
        return false;
    }

    return $requestPort === $expectedPort;
}

function resolveRequestScheme(): string
{
    if (TrustedProxy::forwardedHeadersTrusted($_SERVER)) {
        $forwardedProto = $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '';
        if (is_string($forwardedProto) && trim($forwardedProto) !== '') {
            $schemeCandidate = explode(',', $forwardedProto)[0] ?? '';
            return strtolower(trim((string) $schemeCandidate)) === 'https' ? 'https' : 'http';
        }
    }

    if (!empty($_SERVER['REQUEST_SCHEME']) && is_string($_SERVER['REQUEST_SCHEME'])) {
        return strtolower($_SERVER['REQUEST_SCHEME']) === 'https' ? 'https' : 'http';
    }

    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
}

function resolveRequestHost(): string
{
    if (TrustedProxy::forwardedHeadersTrusted($_SERVER)) {
        $forwardedHostHeader = $_SERVER['HTTP_X_FORWARDED_HOST'] ?? '';
        if (is_string($forwardedHostHeader) && trim($forwardedHostHeader) !== '') {
            return trim((string) (explode(',', $forwardedHostHeader)[0] ?? ''));
        }
    }

    $hostHeader = $_SERVER['HTTP_HOST'] ?? '';
    if (is_string($hostHeader) && trim($hostHeader) !== '') {
        return trim($hostHeader);
    }

    $serverName = $_SERVER['SERVER_NAME'] ?? '';
    if (is_string($serverName)) {
        return trim($serverName);
    }

    return '';
}

function resolveRequestOrigin(): ?string
{
    $host = resolveRequestHost();
    if ($host === '') {
        return null;
    }

    return normalizeOrigin(resolveRequestScheme() . '://' . $host);
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

function resolveSeedBaseUrl(?array $tokenRow = null): string
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

function seedAuthCommand(string $baseUrl, string $token): string
{
    $base = rtrim($baseUrl, '/');

    return sprintf('curl -fsSL "%s/seed/auth/%s" | bash', $base, $token);
}

function installerTokenExpired(array $tokenRow): bool
{
    $expires = strtotime($tokenRow['expires_at'] ?? '');
    if ($expires === false) {
        return true;
    }

    return $expires < time();
}

function seedAuthTokenExpired(array $tokenRow): bool
{
    $expires = strtotime($tokenRow['expires_at'] ?? '');
    if ($expires === false) {
        return true;
    }

    return $expires < time();
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

function emitSeedScript(string $body, int $status = 200, ?string $expiresAt = null): void
{
    http_response_code($status);
    header('Content-Type: text/x-shellscript; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Cache-Control: no-store, must-revalidate');
    if ($expiresAt !== null) {
        header('X-Seed-Expires-At: ' . $expiresAt);
    }
    echo $body;
    exit;
}

function installerError(string $message, int $status = 400, ?string $expiresAt = null): void
{
    emitInstaller('echo "' . addslashes($message) . "\" >&2\nexit 1\n", $status, $expiresAt);
}

function seedAuthError(string $message, int $status = 400, ?string $expiresAt = null): void
{
    emitSeedScript('echo "' . addslashes($message) . "\" >&2\nexit 1\n", $status, $expiresAt);
}

function adminAccessMode(): string
{
    $mode = Config::get('ADMIN_ACCESS_MODE', 'mtls');
    $normalized = strtolower(trim((string) $mode));
    return $normalized === 'none' ? 'none' : 'mtls';
}

function isMtlsRequired(): bool
{
    $mode = adminAccessMode();
    return $mode === 'mtls';
}

function isMtlsSatisfied(): bool
{
    // Treat mTLS as satisfied only when we actually got a 64-hex fingerprint header
    // (Caddy may pass literal placeholders when no cert is presented; filter that out).
    $fp = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? ($_SERVER['HTTP_X_MTLS_PRESENT'] ?? '');
    return is_string($fp) && preg_match('/^[A-Fa-f0-9]{64}$/', $fp) === 1;
}

function isHttpsRequest(): bool
{
    return resolveRequestScheme() === 'https';
}

function resolveAdminSessionToken(AdminAuthService $adminAuthService): ?string
{
    $cookieName = $adminAuthService->sessionCookieName();
    $token = $_COOKIE[$cookieName] ?? null;
    if (!is_string($token)) {
        return null;
    }
    $token = trim($token);
    return $token === '' ? null : $token;
}

function resolveAdminSession(AdminAuthService $adminAuthService): ?array
{
    if (array_key_exists('admin_auth_session', $GLOBALS)) {
        $cached = $GLOBALS['admin_auth_session'];
        return is_array($cached) ? $cached : null;
    }

    $session = $adminAuthService->resolveSession(resolveAdminSessionToken($adminAuthService));
    $GLOBALS['admin_auth_session'] = $session;
    return $session;
}

function requireAdminAccess(): void
{
    $mode = adminAccessMode();
    $mtlsOk = isMtlsSatisfied();
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

    $mtlsRequired = $mode === 'mtls';

    if ($mtlsRequired && !$mtlsOk) {
        Response::json([
            'status' => 'error',
            'message' => 'Client certificate required for admin access',
        ], 403);
    }

    $adminAuthService = $GLOBALS['adminAuthService'] ?? null;
    if (!$adminAuthService instanceof AdminAuthService) {
        return;
    }

    if (!$adminAuthService->isEnforced()) {
        return;
    }

    $path = rtrim($path, '/');
    if ($path === '') {
        $path = '/';
    }
    $bypass = [
        '/admin/auth/status',
        '/admin/auth/login',
        '/admin/auth/login/method',
        '/admin/auth/logout',
        '/admin/auth/password/request',
        '/admin/auth/password/reset',
        '/admin/auth/passkey/login/options',
        '/admin/auth/passkey/login',
    ];
    if (in_array($path, $bypass, true)) {
        return;
    }

    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user'])) {
        Response::json([
            'status' => 'error',
            'message' => 'Authentication required',
        ], 401);
    }

    $GLOBALS['adminAuthUser'] = $session['user'];
}

function requireAdminCapability(string $capability): void
{
    $adminAuthService = $GLOBALS['adminAuthService'] ?? null;
    if (!$adminAuthService instanceof AdminAuthService) {
        return;
    }
    if (!$adminAuthService->isEnforced()) {
        return;
    }

    $session = resolveAdminSession($adminAuthService);
    try {
        $adminAuthService->enforceCapability($session['user'] ?? null, $capability);
    } catch (HttpException $exception) {
        Response::json([
            'status' => 'error',
            'message' => $exception->getMessage(),
        ], $exception->getStatusCode());
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

function resolveStringQuery(string $key): ?string
{
    if (!isset($_GET[$key])) {
        return null;
    }

    if (is_array($_GET[$key])) {
        return null;
    }

    $value = trim((string) $_GET[$key]);
    return $value === '' ? null : $value;
}

function adminWebAuthnRpId(): string
{
    $configured = Config::get('ADMIN_WEBAUTHN_RP_ID', '');
    if (is_string($configured) && trim($configured) !== '') {
        return trim($configured);
    }

    $publicBase = normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''));
    if ($publicBase !== '') {
        $host = parse_url($publicBase, PHP_URL_HOST);
        if (is_string($host) && trim($host) !== '') {
            return trim($host);
        }
    }

    $host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
    if (!is_string($host)) {
        return 'localhost';
    }
    return preg_replace('/:\d+$/', '', $host);
}

function adminWebAuthnRpName(): string
{
    $configured = Config::get('ADMIN_WEBAUTHN_RP_NAME', '');
    if (is_string($configured) && trim($configured) !== '') {
        return trim($configured);
    }
    return 'Codex Orchestrator';
}

function adminWebAuthnOrigin(): string
{
    $configured = Config::get('ADMIN_WEBAUTHN_ORIGIN', '');
    if (is_string($configured) && trim($configured) !== '') {
        $normalized = normalizeOrigin($configured);
        if ($normalized !== null) {
            return $normalized;
        }
    }

    $publicBase = normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''));
    if ($publicBase !== '') {
        $publicOrigin = normalizeOrigin($publicBase);
        if ($publicOrigin !== null) {
            return $publicOrigin;
        }
    }

    $origin = resolveRequestOrigin();
    if ($origin !== null) {
        return $origin;
    }

    $scheme = resolveRequestScheme();
    $host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
    if (!is_string($host) || trim($host) === '') {
        $host = 'localhost';
    }
    return normalizeOrigin($scheme . '://' . trim($host)) ?? ($scheme . '://' . trim($host));
}

