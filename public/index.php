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
use App\Http\TrustedProxy;
use App\Repositories\AuthEntryRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\AuthSeedTokenRepository;
use App\Repositories\AdminEventRepository;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminPasswordResetRepository;
use App\Repositories\AdminSessionRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\AdminWebAuthnChallengeRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\InstallTokenRepository;
use App\Repositories\InsecureAuthRequestRepository;
use App\Repositories\InsecureDomainAllowRepository;
use App\Repositories\LogRepository;
use App\Repositories\ChatGptUsageRepository;
use App\Repositories\IpRateLimitRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\VersionRepository;
use App\Repositories\PricingSnapshotRepository;
use App\Repositories\ProjectEventRepository;
use App\Repositories\ProjectFeedbackRepository;
use App\Repositories\ProjectFileRepository;
use App\Repositories\ProjectNoteRepository;
use App\Repositories\ProjectRepository;
use App\Repositories\ProjectTodoRepository;
use App\Repositories\SlashCommandRepository;
use App\Repositories\AgentsRepository;
use App\Repositories\SkillRepository;
use App\Repositories\MemoryRepository;
use App\Repositories\ClientConfigRepository;
use App\Repositories\McpAccessLogRepository;
use App\Repositories\McpSessionTokenRepository;
use App\Services\AuthService;
use App\Services\AdminAuthService;
use App\Services\AdminPasskeyService;
use App\Services\AdminUserService;
use App\Services\WrapperService;
use App\Services\RunnerVerifier;
use App\Services\ChatGptUsageService;
use App\Services\PricingService;
use App\Services\CostHistoryService;
use App\Services\ProjectCoordinationService;
use App\Services\ProjectModuleService;
use App\Services\UsageCostService;
use App\Services\SlashCommandService;
use App\Services\AgentsService;
use App\Services\SkillService;
use App\Services\MemoryService;
use App\Services\ClientConfigService;
use App\Services\StartupSyncService;
use App\Mcp\McpServer;
use App\Mcp\McpToolNotFoundException;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use App\Security\RateLimiter;
use App\Support\CodexVersionPolicy;
use App\Support\Installation;
use App\Support\InstallerScriptBuilder;
use App\Support\Mailer;
use App\Support\SeedAuthScriptBuilder;
use Dotenv\Dotenv;

require __DIR__ . '/../vendor/autoload.php';

// Ensure errors do not leak HTML into shell outputs.
ini_set('display_errors', '0');
ini_set('html_errors', '0');

$root = dirname(__DIR__);

require_once $root . '/src/Http/helpers.php';

if (file_exists($root . '/.env')) {
    Dotenv::createImmutable($root)->safeLoad();
}

$router = new Router();

$installationId = Installation::ensure($root);

$keyManager = new EncryptionKeyManager($root);
$keyring = $keyManager->getKeyring();
$secretBox = new SecretBox($keyring['active_key'], $keyring['active_kid'], $keyring['keys']);
$appEnvRaw = strtolower(trim((string) Config::get('APP_ENV', 'development')));
$isProductionEnv = in_array($appEnvRaw, ['prod', 'production'], true);
$envBool = static function (mixed $value, bool $default): bool {
    if (is_bool($value)) {
        return $value;
    }
    if (is_int($value)) {
        return $value !== 0;
    }
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if (in_array($normalized, ['1', 'true', 'yes', 'on'], true)) {
            return true;
        }
        if (in_array($normalized, ['0', 'false', 'no', 'off'], true)) {
            return false;
        }
    }

    return $default;
};
$runMigrationsOnBoot = $envBool(Config::get('RUN_MIGRATIONS_ON_BOOT', $isProductionEnv ? '0' : '1'), !$isProductionEnv);
$runBackfillsOnBoot = $envBool(Config::get('RUN_BACKFILLS_ON_BOOT', $isProductionEnv ? '0' : '1'), !$isProductionEnv);

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
// Avoid running full schema DDL on every request (can add seconds of latency under Apache/mod_php).
// Use a durable sentinel keyed to the Database.php content hash so schema changes trigger a new migrate.
$schemaHash = hash_file('sha256', $root . '/src/Database.php') ?: '';
$schemaKey = $schemaHash !== '' ? substr($schemaHash, 0, 12) : 'unknown';
$sentinelDir = $root . '/storage/wrapper';
if (!is_dir($sentinelDir)) {
    @mkdir($sentinelDir, 0775, true);
}
$migrateSentinel = $sentinelDir . '/.db_migrated_' . $schemaKey;
$migrateLockPath = $sentinelDir . '/.db_migrate.lock';
if ($runMigrationsOnBoot) {
    if (!is_file($migrateSentinel)) {
        $lock = @fopen($migrateLockPath, 'c+');
        if (is_resource($lock)) {
            @flock($lock, LOCK_EX);
        }
        // Re-check after acquiring the lock to avoid duplicate work when multiple workers start at once.
        if (!is_file($migrateSentinel)) {
            $database->migrate();
            @file_put_contents($migrateSentinel, gmdate(DATE_ATOM) . "\n");
        }
        if (is_resource($lock)) {
            @flock($lock, LOCK_UN);
            @fclose($lock);
        }
    }
} else {
    error_log('[migrate] skipped schema migration on request path; run scripts/migrate.php before serving traffic.');
}

$versionRepository = new VersionRepository($database);

$encryptionMigrator = new AuthEncryptionMigrator($database, $secretBox);
// One-time backfill: encrypt legacy auth storage rows with SecretBox.
// This can be expensive on large datasets; gate behind a durable versions flag.
if ($runBackfillsOnBoot && $versionRepository->get('auth_secretbox_migration_v1') === null) {
    try {
        $encryptionMigrator->migrate();
        $versionRepository->set('auth_secretbox_migration_v1', gmdate(DATE_ATOM));
    } catch (\Throwable $exception) {
        error_log('[encryption] migration failed: ' . $exception->getMessage());
    }
}

$hostRepository = new HostRepository($database, $secretBox);
// One-time backfill: legacy host rows may store api_key without enc/hash columns.
if ($runBackfillsOnBoot && $versionRepository->get('hosts_api_key_encryption_backfill_v1') === null) {
    try {
        $hostRepository->backfillApiKeyEncryption();
        $versionRepository->set('hosts_api_key_encryption_backfill_v1', gmdate(DATE_ATOM));
    } catch (\Throwable $exception) {
        error_log('[hosts] api key backfill failed: ' . $exception->getMessage());
    }
}
$hostStateRepository = new HostAuthStateRepository($database);
$digestRepository = new HostAuthDigestRepository($database);
$hostUserRepository = new HostUserRepository($database);
$installTokenRepository = new InstallTokenRepository($database, $secretBox);
$seedTokenRepository = new AuthSeedTokenRepository($database, $secretBox);
$authEntryRepository = new AuthEntryRepository($database, $secretBox);
$authPayloadRepository = new AuthPayloadRepository($database, $authEntryRepository, $secretBox);
$adminEventRepository = new AdminEventRepository($database);
$logRepository = new LogRepository($database, $adminEventRepository);
$adminUserRepository = new AdminUserRepository($database);
$adminSessionRepository = new AdminSessionRepository($database);
$adminPasswordResetRepository = new AdminPasswordResetRepository($database);
$mailer = new Mailer();
$insecureAuthRequestRepository = new InsecureAuthRequestRepository($database);
$insecureDomainAllowRepository = new InsecureDomainAllowRepository($database);
$chatGptUsageRepository = new ChatGptUsageRepository($database);
$slashCommandRepository = new SlashCommandRepository($database);
$skillRepository = new SkillRepository($database);
$agentsRepository = new AgentsRepository($database);
$memoryRepository = new MemoryRepository($database);
$projectRepository = new ProjectRepository($database);
$projectNoteRepository = new ProjectNoteRepository($database);
$projectTodoRepository = new ProjectTodoRepository($database);
$projectFileRepository = new ProjectFileRepository($database);
$projectFeedbackRepository = new ProjectFeedbackRepository($database);
$projectEventRepository = new ProjectEventRepository($database);
$clientConfigRepository = new ClientConfigRepository($database);
$mcpAccessLogRepository = new McpAccessLogRepository($database);
$mcpSessionTokenRepository = new McpSessionTokenRepository($database, $secretBox);
$ipRateLimitRepository = new IpRateLimitRepository($database);
$tokenUsageRepository = new TokenUsageRepository($database);
$tokenUsageIngestRepository = new TokenUsageIngestRepository($database);
$pricingSnapshotRepository = new PricingSnapshotRepository($database);
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
$wrapperService = new WrapperService($versionRepository, $wrapperStoragePath, $wrapperSeedPath, $installationId, $secretBox);
$runnerVerifier = null;
$runnerUrl = Config::get('AUTH_RUNNER_URL', '');
if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
    $runnerVerifier = new RunnerVerifier(
        $runnerUrl,
        (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api'),
        (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0),
        (string) Config::get('AUTH_RUNNER_SHARED_SECRET', '')
    );
}
$rateLimiter = new RateLimiter($ipRateLimitRepository);
$service = new AuthService(
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
    $insecureAuthRequestRepository,
    $runnerVerifier,
    $rateLimiter,
    $installationId,
    null,
    $insecureDomainAllowRepository,
    $mcpSessionTokenRepository
);
$adminPasskeyRepository = new AdminPasskeyRepository($database);
$adminAuthService = new AdminAuthService(
    $adminUserRepository,
    $adminSessionRepository,
    $adminPasswordResetRepository,
    $logRepository,
    $mailer,
    $adminPasskeyRepository
);
$adminUserService = new AdminUserService(
    $adminUserRepository,
    $adminSessionRepository,
    $adminPasswordResetRepository,
    $logRepository,
    $adminAuthService
);
$adminWebAuthnChallengeRepository = new AdminWebAuthnChallengeRepository($database);
$adminPasskeyService = new AdminPasskeyService(
    $adminPasskeyRepository,
    $adminWebAuthnChallengeRepository,
    $adminUserRepository,
    $logRepository
);
$GLOBALS['adminAuthService'] = $adminAuthService;
$slashCommandService = new SlashCommandService($slashCommandRepository, $logRepository);
$projectModuleService = new ProjectModuleService($versionRepository);
$skillService = new SkillService($skillRepository, $logRepository, $projectModuleService);
$agentsService = new AgentsService($agentsRepository, $logRepository);
$memoryService = new MemoryService($memoryRepository, $logRepository);
$projectCoordinationService = new ProjectCoordinationService(
    $projectRepository,
    $projectNoteRepository,
    $projectTodoRepository,
    $projectFileRepository,
    $projectFeedbackRepository,
    $projectEventRepository,
    $projectModuleService,
    $logRepository
);
$mcpServer = new McpServer($memoryService, $projectCoordinationService, $skillService, $root);
$clientConfigService = new ClientConfigService($clientConfigRepository, $logRepository, $versionRepository, $mcpSessionTokenRepository);
$startupSyncService = new StartupSyncService($slashCommandService, $skillService, $agentsService, $clientConfigService);
$chatGptUsageService = new ChatGptUsageService(
    $service,
    $chatGptUsageRepository,
    $logRepository,
    (string) Config::get('CHATGPT_BASE_URL', 'https://chatgpt.com/backend-api'),
    (float) Config::get('CHATGPT_USAGE_TIMEOUT', 10.0)
);
$costHistoryService = new CostHistoryService($tokenUsageRepository, $pricingService, $pricingModel);
$usageCostService = new UsageCostService($tokenUsageRepository, $tokenUsageIngestRepository, $pricingService, $versionRepository, $pricingModel);
$agentsService->ensureSeededFromFile($root . '/AGENTS.md');
$wrapperService->ensureSeeded();
if ($runBackfillsOnBoot) {
    $usageCostService->backfillMissingCosts();
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$normalizedPath = rtrim($path, '/');
if ($normalizedPath === '') {
    $normalizedPath = '/';
}

enforcePublicBaseUrlPolicy($normalizedPath);

// First non-admin API hit after ~8 hours (or boot): refresh GitHub client version cache and run auth runner once.
// Avoid doing preflight work on ultra-hot, unauthenticated endpoints (health checks) or latency-sensitive MCP init.
if (!str_starts_with($normalizedPath, '/admin') && $normalizedPath !== '/versions' && !str_starts_with($normalizedPath, '/mcp') && !str_starts_with($normalizedPath, '/cron')) {
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

$respondProjectAction = static function (callable $callback): void {
    try {
        $result = $callback();
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
};

// --- Cron auto-update endpoints (host-facing, lighter auth that works for disabled hosts) ---

$router->add('POST', '#^/cron/check$#', function () use ($service, $hostRepository, $versionRepository, $logRepository, $payload) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticateForCron($apiKey, $clientIp);
    $hostId = (int) $host['id'];

    $hostRepository->touchLastCronCheck($hostId);

    // Resolve effective auto-update setting: per-host override wins, then fleet default.
    $override = $host['auto_update_override'] ?? null;
    if ($override !== null) {
        $autoUpdateEnabled = (bool) (int) $override;
    } else {
        $autoUpdateEnabled = $versionRepository->getFlag('auto_update_enabled', false);
    }

    if (!$autoUpdateEnabled) {
        Response::json([
            'status' => 'ok',
            'data' => ['action' => 'disable'],
        ]);
    }

    // Resolve effective target version for this host.
    $versions = $service->versionSummary();
    $versions = $service->applyClientVersionOverrideForHost($versions, $host);

    $targetVersion = CodexVersionPolicy::normalize($versions['client_version'] ?? null);
    $enforceExact = $versions['client_version_enforce_exact'] ?? false;
    $submittedVersion = CodexVersionPolicy::normalize($payload['client_version'] ?? null);

    $needUpdate = false;
    if ($targetVersion !== null && $submittedVersion !== null) {
        if ($enforceExact) {
            $needUpdate = ($submittedVersion !== $targetVersion);
        } else {
            $needUpdate = version_compare($submittedVersion, $targetVersion, '<');
        }
    } elseif ($targetVersion !== null && $submittedVersion === null) {
        $needUpdate = true;
    }

    if (!$needUpdate) {
        Response::json([
            'status' => 'ok',
            'data' => ['action' => 'no_update'],
        ]);
    }

    // Determine the release tag candidates for the client to resolve from GitHub.
    $tag = $targetVersion;

    $logRepository->log($hostId, 'cron.update_available', [
        'current' => $submittedVersion,
        'target' => $targetVersion,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'action' => 'update',
            'target_version' => $targetVersion,
            'tag' => $tag,
            'enforce_exact' => $enforceExact,
        ],
    ]);
});

$router->add('POST', '#^/cron/report$#', function () use ($service, $hostRepository, $logRepository, $payload) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticateForCron($apiKey, $clientIp);
    $hostId = (int) $host['id'];

    $clientVersion = $payload['client_version'] ?? null;
    if (!is_string($clientVersion) || trim($clientVersion) === '') {
        Response::json([
            'status' => 'error',
            'message' => 'client_version is required',
        ], 422);
    }

    $normalized = CodexVersionPolicy::normalize($clientVersion);
    if ($normalized === null) {
        Response::json([
            'status' => 'error',
            'message' => 'Invalid client_version',
        ], 422);
    }

    $hostRepository->updateClientVersions($hostId, $normalized, $host['wrapper_version'] ?? null);

    $logRepository->log($hostId, 'cron.update_reported', [
        'client_version' => $normalized,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => ['recorded' => true],
    ]);
});

// --- End cron auto-update endpoints ---

$router->add('GET', '#^/versions$#', function () use ($service) {
    $versions = $service->versionSummary();

    Response::json([
        'status' => 'ok',
        'data' => $versions,
    ]);
});

function isBrowserRequest(): bool {
    $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
    return stripos($accept, 'text/html') !== false;
}

$router->add('GET', '#^/admin/?$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/login$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/hosts/(\\d+)$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/dashboard$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/account(?:/(password|passkeys))?$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/settings$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/settings/(general|agents|prompts|memories|projects|profiles|skills|config)$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/hosts/secure$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/hosts/unprovisioned$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('GET', '#^/admin/logs/(mcp|events)$#', function (): void {
    require __DIR__ . '/admin/index.php';
});

$router->add('POST', '#^/admin/versions/check$#', function () use ($service) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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

$router->add('GET', '#^/admin/auth/status$#', function () use ($adminAuthService, $adminUserRepository, $adminPasskeyRepository) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    $userId = $session['user']['id'] ?? null;
    $passkeyCount = ($userId !== null) ? $adminPasskeyRepository->countForUser((int) $userId) : 0;
    Response::json([
        'status' => 'ok',
        'data' => [
            'has_users' => $adminUserRepository->countUsers() > 0,
            'admin_count' => $adminUserRepository->countAdmins(true),
            'enforced' => $adminAuthService->isEnforced(),
            'authenticated' => $session !== null,
            'user' => $session['user'] ?? null,
            'roles' => $adminAuthService->roleLabels(),
            'passkeys_registered' => $passkeyCount,
            'passkey_login_available' => $adminPasskeyRepository->countAll() > 0,
        ],
    ]);
});

$router->add('POST', '#^/admin/auth/login$#', function () use ($payload, $adminAuthService) {
    requireAdminAccess();
    $username = is_array($payload) ? (string) ($payload['username'] ?? '') : '';
    $password = is_array($payload) ? (string) ($payload['password'] ?? '') : '';
    $ip = resolveClientIp();
    $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? null;

    $result = $adminAuthService->login($username, $password, $ip, is_string($userAgent) ? $userAgent : null);
    $cookieName = $adminAuthService->sessionCookieName();
    $expires = strtotime((string) ($result['expires_at'] ?? '')) ?: (time() + $adminAuthService->sessionTtlSeconds());
    setcookie($cookieName, $result['token'], [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => isHttpsRequest(),
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'user' => $result['user'],
            'expires_at' => $result['expires_at'],
        ],
    ]);
});

$router->add('POST', '#^/admin/auth/login/method$#', function () use ($payload, $adminAuthService) {
    requireAdminAccess();
    $username = is_array($payload) ? (string) ($payload['username'] ?? '') : '';

    Response::json([
        'status' => 'ok',
        'data' => [
            'method' => $adminAuthService->resolveLoginMethod($username),
        ],
    ]);
});

$router->add('POST', '#^/admin/auth/logout$#', function () use ($adminAuthService) {
    requireAdminAccess();
    $token = resolveAdminSessionToken($adminAuthService);
    $adminAuthService->logout($token);
    $cookieName = $adminAuthService->sessionCookieName();
    setcookie($cookieName, '', [
        'expires' => time() - 3600,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => isHttpsRequest(),
    ]);

    Response::json([
        'status' => 'ok',
    ]);
});

$router->add('POST', '#^/admin/auth/password/change$#', function () use ($payload, $adminAuthService) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user']['id'])) {
        Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
    }

    $currentPassword = is_array($payload) ? (string) ($payload['current_password'] ?? '') : '';
    $newPassword = is_array($payload) ? (string) ($payload['new_password'] ?? '') : '';
    $confirmPassword = is_array($payload) ? (string) ($payload['confirm_password'] ?? '') : '';
    if ($newPassword !== $confirmPassword) {
        throw new ValidationException(['confirm_password' => 'Password confirmation does not match.']);
    }

    $user = $adminAuthService->changePassword(
        (int) $session['user']['id'],
        $currentPassword,
        $newPassword,
        resolveAdminSessionToken($adminAuthService)
    );

    Response::json([
        'status' => 'ok',
        'data' => [
            'user' => $user,
        ],
    ]);
});

$router->add('POST', '#^/admin/auth/password/request$#', function () {
    requireAdminAccess();
    Response::json([
        'status' => 'error',
        'message' => 'Password reset is disabled',
    ], 410);
});

$router->add('POST', '#^/admin/auth/password/reset$#', function () {
    requireAdminAccess();
    Response::json([
        'status' => 'error',
        'message' => 'Password reset is disabled',
    ], 410);
});

// --- Passkey login (unauthenticated) ---

$router->add('POST', '#^/admin/auth/passkey/login/options$#', function () use ($payload, $adminPasskeyService) {
    requireAdminAccess();
    $username = is_array($payload) ? (string) ($payload['username'] ?? '') : '';
    $rpId = adminWebAuthnRpId();
    $options = $adminPasskeyService->beginAuthentication($username, $rpId);
    Response::json(['status' => 'ok', 'data' => $options]);
});

$router->add('POST', '#^/admin/auth/passkey/login$#', function () use ($payload, $adminPasskeyService, $adminAuthService) {
    requireAdminAccess();
    $rpId = adminWebAuthnRpId();
    $origin = adminWebAuthnOrigin();
    $user = $adminPasskeyService->completeAuthentication(
        is_array($payload) ? $payload : [],
        $rpId,
        $origin
    );

    $result = $adminAuthService->createSessionForUser(
        $user,
        resolveClientIp(),
        is_string($_SERVER['HTTP_USER_AGENT'] ?? null) ? $_SERVER['HTTP_USER_AGENT'] : null,
        'admin.auth.passkey.login'
    );

    $cookieName = $adminAuthService->sessionCookieName();
    $expires = strtotime((string) ($result['expires_at'] ?? '')) ?: (time() + $adminAuthService->sessionTtlSeconds());
    setcookie($cookieName, $result['token'], [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => isHttpsRequest(),
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'user' => $result['user'],
            'expires_at' => $result['expires_at'],
        ],
    ]);
});

// --- Passkey registration (authenticated) ---

$router->add('POST', '#^/admin/auth/passkey/register/options$#', function () use ($adminPasskeyService, $adminAuthService) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user'])) {
        Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
    }
    $rpId = adminWebAuthnRpId();
    $rpName = adminWebAuthnRpName();
    $options = $adminPasskeyService->beginRegistration($session['user'], $rpId, $rpName);
    Response::json(['status' => 'ok', 'data' => $options]);
});

$router->add('POST', '#^/admin/auth/passkey/register$#', function () use ($payload, $adminPasskeyService, $adminAuthService) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user'])) {
        Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
    }
    $rpId = adminWebAuthnRpId();
    $origin = adminWebAuthnOrigin();
    $passkey = $adminPasskeyService->completeRegistration(
        $session['user'],
        is_array($payload) ? $payload : [],
        $rpId,
        $origin
    );
    Response::json(['status' => 'ok', 'data' => ['passkey' => $passkey]]);
});

// --- Passkey management (authenticated) ---

$router->add('GET', '#^/admin/passkeys$#', function () use ($adminPasskeyService, $adminAuthService) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user'])) {
        Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
    }
    $passkeys = $adminPasskeyService->listForUser((int) $session['user']['id']);
    Response::json(['status' => 'ok', 'data' => ['passkeys' => $passkeys]]);
});

$router->add('POST', '#^/admin/passkeys/(\d+)/name$#', function ($id) use ($payload, $adminPasskeyService, $adminAuthService) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user'])) {
        Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
    }
    $name = is_array($payload) ? trim((string) ($payload['name'] ?? '')) : '';
    if ($name === '') {
        Response::json(['status' => 'error', 'message' => 'Name is required'], 422);
    }
    $adminPasskeyService->updatePasskeyName((int) $id, (int) $session['user']['id'], $name);
    Response::json(['status' => 'ok']);
});

$router->add('DELETE', '#^/admin/passkeys/(\d+)$#', function ($id) use ($adminPasskeyService, $adminAuthService) {
    requireAdminAccess();
    $session = resolveAdminSession($adminAuthService);
    if ($session === null || !isset($session['user'])) {
        Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
    }
    $adminPasskeyService->deletePasskey((int) $id, (int) $session['user']['id']);
    Response::json(['status' => 'ok']);
});

$router->add('GET', '#^/admin/users$#', function () use ($adminUserService, $adminUserRepository) {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    requireAdminAccess();
    $hasUsers = $adminUserRepository->countUsers() > 0;
    if ($hasUsers) {
        requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
    }
    Response::json([
        'status' => 'ok',
        'data' => [
            'users' => $adminUserService->listUsers(),
        ],
    ]);
});

$router->add('POST', '#^/admin/users$#', function () use ($payload, $adminUserService, $adminUserRepository) {
    requireAdminAccess();
    $hasUsers = $adminUserRepository->countUsers() > 0;
    if ($hasUsers) {
        requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
    }
    $user = $adminUserService->createUser(is_array($payload) ? $payload : []);
    Response::json([
        'status' => 'ok',
        'data' => [
            'user' => $user,
        ],
    ]);
});

$router->add('POST', '#^/admin/users/(\\d+)$#', function ($id) use ($payload, $adminUserService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
    $id = (int) $id;
    $user = $adminUserService->updateUser($id, is_array($payload) ? $payload : []);
    Response::json([
        'status' => 'ok',
        'data' => [
            'user' => $user,
        ],
    ]);
});

$router->add('DELETE', '#^/admin/users/(\\d+)$#', function ($id) use ($adminUserService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
    $id = (int) $id;
    $adminUserService->deleteUser($id);
    Response::json([
        'status' => 'ok',
    ]);
});

$router->add('POST', '#^/admin/users/wipe$#', function () use ($payload, $adminUserService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_USERS_MANAGE);
    $confirm = is_array($payload) ? ($payload['confirm'] ?? null) : null;
    if ($confirm !== 'WIPE') {
        Response::json([
            'status' => 'error',
            'message' => 'Confirmation required',
        ], 422);
    }
    $adminUserService->wipeAllUsers();
    Response::json([
        'status' => 'ok',
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

$router->add('GET', '#^/install/([a-f0-9\-]{36})$#i', function ($tokenValue) use ($installTokenRepository, $hostRepository, $logRepository, $service) {
    $tokenValue = (string) $tokenValue;
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

    // Some legacy/insecure-host paths ended up writing install_tokens with an empty api_key
    // (hash of ""), which breaks the installer emission. Recover by decrypting the host's
    // encrypted API key when the token payload is blank.
    if (empty($tokenRow['api_key'] ?? '')) {
        $hostPlain = $hostRepository->decryptApiKey($host['api_key_enc'] ?? null);
        if ($hostPlain) {
            $tokenRow['api_key'] = $hostPlain;
        }
    }

    $baseUrl = resolveInstallerBaseUrl($tokenRow);
    if ($baseUrl === '') {
        installerError('Installer base URL invalid', 500, $tokenRow['expires_at'] ?? null);
    }

    $installTokenRepository->markUsed((int) $tokenRow['id']);
    $logRepository->log($hostId, 'install.token.consume', [
        'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
    ]);

    try {
        $body = InstallerScriptBuilder::build($host, $tokenRow, $baseUrl, $service->versionSummary());
    } catch (\InvalidArgumentException $exception) {
        installerError($exception->getMessage(), 500, $tokenRow['expires_at'] ?? null);
    }
    emitInstaller($body, 200, $tokenRow['expires_at'] ?? null);
});

$router->add('GET', '#^/seed/auth/([a-f0-9\-]{36})$#i', function ($tokenValue) use ($seedTokenRepository) {
    $tokenRow = $seedTokenRepository->findByToken($tokenValue);
    if (!$tokenRow) {
        seedAuthError('Seed token not found', 404);
    }
    if ($tokenRow['used_at'] ?? null) {
        seedAuthError('Seed token already used', 410);
    }
    if (seedAuthTokenExpired($tokenRow)) {
        seedAuthError('Seed token expired', 410);
    }

    $baseUrl = resolveSeedBaseUrl($tokenRow);
    if ($baseUrl === '') {
        seedAuthError('Seed base URL invalid', 500, $tokenRow['expires_at'] ?? null);
    }

    try {
        $body = SeedAuthScriptBuilder::build($baseUrl, (string) $tokenRow['token']);
    } catch (\InvalidArgumentException $exception) {
        seedAuthError($exception->getMessage(), 500, $tokenRow['expires_at'] ?? null);
    }

    emitSeedScript($body, 200, $tokenRow['expires_at'] ?? null);
});

$router->add('POST', '#^/seed/auth/([a-f0-9\-]{36})$#i', function ($tokenValue) use ($seedTokenRepository, $service, $logRepository) {
    $tokenRow = $seedTokenRepository->findByToken($tokenValue);
    if (!$tokenRow) {
        Response::json([
            'status' => 'error',
            'message' => 'Seed token not found',
        ], 404);
    }
    if ($tokenRow['used_at'] ?? null) {
        Response::json([
            'status' => 'error',
            'message' => 'Seed token already used',
        ], 410);
    }
    if (seedAuthTokenExpired($tokenRow)) {
        Response::json([
            'status' => 'error',
            'message' => 'Seed token expired',
        ], 410);
    }

    $raw = file_get_contents('php://input');
    $decoded = null;
    if (is_string($raw) && trim($raw) !== '') {
        $decoded = json_decode($raw, true);
    }

    if (!is_array($decoded)) {
        $seedTokenRepository->markUsed((int) $tokenRow['id']);
        $logRepository->log(null, 'auth.seed.consume', [
            'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
            'status' => 'invalid_json',
        ]);
        Response::json([
            'status' => 'error',
            'message' => 'auth.json payload must be valid JSON',
        ], 422);
    }

    $authPayload = $decoded['auth'] ?? $decoded;
    if (!is_array($authPayload)) {
        $seedTokenRepository->markUsed((int) $tokenRow['id']);
        $logRepository->log(null, 'auth.seed.consume', [
            'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
            'status' => 'invalid_payload',
        ]);
        Response::json([
            'status' => 'error',
            'message' => 'auth.json payload must be an object',
        ], 422);
    }

    $seedTokenRepository->markUsed((int) $tokenRow['id']);
    $logRepository->log(null, 'auth.seed.consume', [
        'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
    ]);

    $host = [
        'id' => 0,
        'fqdn' => '[seed]',
        'status' => 'active',
        'api_calls' => 0,
        'allow_roaming_ips' => true,
        'secure' => true,
    ];

    try {
        $result = $service->handleAuth(
            ['command' => 'store', 'auth' => $authPayload],
            $host,
            'seed-upload',
            null,
            null,
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

$router->add('POST', '#^/admin/hosts/register$#', function () use ($payload, $service, $installTokenRepository, $logRepository, $hostRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);

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

    $temporary = null;
    if (array_key_exists('temporary', $payload)) {
        $temporaryRaw = $payload['temporary'];
        $temporary = $temporaryRaw === null ? false : normalizeBoolean($temporaryRaw);
        if ($temporary === null) {
            Response::json([
                'status' => 'error',
                'message' => 'temporary must be boolean',
            ], 422);
        }
    }

    $curlInsecure = null;
    if (array_key_exists('curl_insecure', $payload)) {
        $curlInsecureRaw = $payload['curl_insecure'];
        $curlInsecure = $curlInsecureRaw === null ? false : normalizeBoolean($curlInsecureRaw);
        if ($curlInsecure === null) {
            Response::json([
                'status' => 'error',
                'message' => 'curl_insecure must be boolean',
            ], 422);
        }
    }

    $reverseDnsMode = null;
    if (array_key_exists('reverse_dns_mode', $payload)) {
        $reverseDnsMode = normalizeReverseDnsModeInput($payload['reverse_dns_mode']);
        if ($reverseDnsMode === null) {
            Response::json([
                'status' => 'error',
                'message' => 'reverse_dns_mode must be one of: global, enabled, disabled',
            ], 422);
        }
    }

    $durationMinutes = null;
    if (array_key_exists('duration_minutes', $payload)) {
        $durationRaw = $payload['duration_minutes'];
        if ($durationRaw !== null && $durationRaw !== '') {
            if (!is_numeric($durationRaw) || (int) $durationRaw != (float) $durationRaw) {
                Response::json([
                    'status' => 'error',
                    'message' => 'duration_minutes must be an integer',
                ], 422);
            }

            $durationMinutes = (int) $durationRaw;
            if ($durationMinutes < AuthService::MIN_INSECURE_WINDOW_MINUTES || $durationMinutes > AuthService::MAX_INSECURE_WINDOW_MINUTES) {
                Response::json([
                    'status' => 'error',
                    'message' => sprintf(
                        'duration_minutes must be between %d and %d',
                        AuthService::MIN_INSECURE_WINDOW_MINUTES,
                        AuthService::MAX_INSECURE_WINDOW_MINUTES
                    ),
                ], 422);
            }
        }
    }

    $hostPayload = $service->register($fqdn, $secure, $durationMinutes);
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

    if ($temporary !== null) {
        $expiresAt = null;
        if ($temporary) {
            $expiresAt = gmdate(DATE_ATOM, time() + 7200);
        }
        $hostRepository->updateExpiresAt((int) $host['id'], $expiresAt);
        $host = $hostRepository->findById((int) $host['id']) ?? $host;
        $hostPayload['expires_at'] = $expiresAt;
    }

    if ($curlInsecure !== null) {
        $hostRepository->updateCurlInsecure((int) $host['id'], $curlInsecure);
        $logRepository->log((int) $host['id'], 'admin.host.curl_insecure', [
            'fqdn' => $host['fqdn'] ?? null,
            'curl_insecure' => $curlInsecure,
        ]);
        $host = $hostRepository->findById((int) $host['id']) ?? $host;
        $hostPayload['curl_insecure'] = $curlInsecure;
    }

    if ($reverseDnsMode !== null) {
        $reverseDnsValue = $reverseDnsMode === 'global' ? null : ($reverseDnsMode === 'enabled');
        $hostRepository->updateReverseDnsMode((int) $host['id'], $reverseDnsValue);
        $logRepository->log((int) $host['id'], 'admin.host.reverse_dns', [
            'fqdn' => $host['fqdn'] ?? null,
            'reverse_dns_mode' => $reverseDnsMode,
        ]);
        $host = $hostRepository->findById((int) $host['id']) ?? $host;
        $hostPayload['reverse_dns_mode'] = $reverseDnsMode;
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
        (string) ($hostPayload['api_key'] ?? ($host['api_key_plain'] ?? '')),
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

$router->add('GET', '#^/admin/runner$#', function () use ($logRepository, $hostRepository, $versionRepository, $authPayloadRepository) {
    requireAdminAccess();

    $runnerUrl = (string) Config::get('AUTH_RUNNER_URL', '');
    $enabled = trim($runnerUrl) !== '';
    $defaultBaseUrl = (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api');
    $timeoutSeconds = (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0);

    $since = gmdate(DATE_ATOM, time() - 86400);
    $latestValidationRow = $logRepository->recentByActions(['auth.validate'], 1);
    $latestRunnerStoreRow = $logRepository->recentByActions(['auth.runner_store'], 1);

    $formatHostBrief = static function (?array $host): ?array {
        if ($host === null) {
            return null;
        }
        return [
            'id' => isset($host['id']) ? (int) $host['id'] : null,
            'fqdn' => $host['fqdn'] ?? null,
            'ip4' => $host['ip4'] ?? null,
            'ip6' => $host['ip6'] ?? null,
        ];
    };

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

    $canonicalPayload = null;
    $canonicalPayloadId = $versionRepository->get('canonical_payload_id');
    if ($canonicalPayloadId !== null && ctype_digit((string) $canonicalPayloadId)) {
        $canonicalPayload = $authPayloadRepository->findMetadataById((int) $canonicalPayloadId);
    }
    if ($canonicalPayload === null) {
        $canonicalPayload = $authPayloadRepository->latestMetadata();
    }

    $canonicalSourceHostId = null;
    $canonicalSourceHost = null;
    if ($canonicalPayload !== null) {
        $raw = $canonicalPayload['source_host_id'] ?? null;
        if ($raw !== null && is_numeric($raw)) {
            $canonicalSourceHostId = (int) $raw;
        }
        if ($canonicalSourceHostId !== null && $canonicalSourceHostId > 0) {
            $canonicalSourceHost = $formatHostBrief($hostRepository->findById($canonicalSourceHostId));
        }
    }

    $canonicalAuth = null;
    if ($canonicalPayload !== null) {
        $canonicalAuth = [
            'payload_id' => isset($canonicalPayload['id']) ? (int) $canonicalPayload['id'] : null,
            'created_at' => $canonicalPayload['created_at'] ?? null,
            'last_refresh' => $canonicalPayload['last_refresh'] ?? null,
            'digest' => $canonicalPayload['sha256'] ?? null,
            'source_host_id' => $canonicalSourceHostId,
            'source_host' => $canonicalSourceHost,
        ];
    }

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
            'canonical_auth' => $canonicalAuth,
        ],
    ]);
});

$router->add('POST', '#^/admin/runner/run$#', function () use ($service) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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

$router->add('POST', '#^/admin/auth/seed-command$#', function () use ($seedTokenRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $seedTokenRepository->deleteExpired(gmdate(DATE_ATOM));

    $ttlSeconds = (int) Config::get('AUTH_SEED_TOKEN_TTL_SECONDS', 900);
    if ($ttlSeconds <= 0) {
        $ttlSeconds = 900;
    }

    $expiresAt = gmdate(DATE_ATOM, time() + $ttlSeconds);
    $baseUrl = resolveSeedBaseUrl();
    if ($baseUrl === '') {
        Response::json([
            'status' => 'error',
            'message' => 'Unable to determine public base URL for seed command. Set PUBLIC_BASE_URL or ensure Host/X-Forwarded-Proto headers are forwarded.',
        ], 500);
    }

    $tokenRow = $seedTokenRepository->create(generateUuid(), $expiresAt, $baseUrl);
    $command = seedAuthCommand($baseUrl, (string) $tokenRow['token']);

    $logRepository->log(null, 'admin.seed_token.create', [
        'expires_at' => $expiresAt,
        'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'command' => $command,
            'expires_at' => $expiresAt,
        ],
    ]);
});

$router->add('POST', '#^/admin/auth/upload$#', function () use ($payload, $hostRepository, $service) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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

$router->add('POST', '#^/admin/api/state$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $disabledRaw = $payload['disabled'] ?? null;
    $disabled = normalizeBoolean($disabledRaw);
    if ($disabled === null) {
        Response::json([
            'status' => 'error',
            'message' => 'disabled must be boolean',
        ], 422);
    }

    $versionRepository->set('api_disabled', $disabled ? '1' : '0');
    $logRepository->log(null, 'admin.api.state', [
        'disabled' => $disabled,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => ['disabled' => $disabled],
    ]);
});

$router->add('GET', '#^/admin/cdx-silent$#', function () use ($versionRepository) {
    requireAdminAccess();

    $silent = $versionRepository->getFlag('cdx_silent', false);

    Response::json([
        'status' => 'ok',
        'data' => ['silent' => $silent],
    ]);
});

$router->add('POST', '#^/admin/cdx-silent$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $silentRaw = $payload['silent'] ?? null;
    $silent = normalizeBoolean($silentRaw);
    if ($silent === null) {
        Response::json([
            'status' => 'error',
            'message' => 'silent must be boolean',
        ], 422);
    }

    $versionRepository->set('cdx_silent', $silent ? '1' : '0');
    $logRepository->log(null, 'admin.cdx_silent', [
        'silent' => $silent,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => ['silent' => $silent],
    ]);
});

$router->add('GET', '#^/admin/reverse-dns$#', function () use ($versionRepository) {
    requireAdminAccess();

    $enabled = $versionRepository->getFlag('reverse_dns_enabled', false);

    Response::json([
        'status' => 'ok',
        'data' => ['enabled' => $enabled],
    ]);
});

$router->add('POST', '#^/admin/reverse-dns$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $enabledRaw = $payload['enabled'] ?? null;
    $enabled = normalizeBoolean($enabledRaw);
    if ($enabled === null) {
        Response::json([
            'status' => 'error',
            'message' => 'enabled must be boolean',
        ], 422);
    }

    $versionRepository->set('reverse_dns_enabled', $enabled ? '1' : '0');
    $logRepository->log(null, 'admin.reverse_dns', [
        'enabled' => $enabled,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => ['enabled' => $enabled],
    ]);
});

$router->add('GET', '#^/admin/auto-update$#', function () use ($versionRepository) {
    requireAdminAccess();

    $enabled = $versionRepository->getFlag('auto_update_enabled', false);

    Response::json([
        'status' => 'ok',
        'data' => ['enabled' => $enabled],
    ]);
});

$router->add('POST', '#^/admin/auto-update$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $enabledRaw = $payload['enabled'] ?? null;
    $enabled = normalizeBoolean($enabledRaw);
    if ($enabled === null) {
        Response::json([
            'status' => 'error',
            'message' => 'enabled must be boolean',
        ], 422);
    }

    $versionRepository->set('auto_update_enabled', $enabled ? '1' : '0');
    $logRepository->log(null, 'admin.auto_update', [
        'enabled' => $enabled,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => ['enabled' => $enabled],
    ]);
});

$router->add('GET', '#^/admin/insecure-approval$#', function () use ($versionRepository) {
    requireAdminAccess();

    $enabled = $versionRepository->getFlag('insecure_approval_enabled', false);

    Response::json([
        'status' => 'ok',
        'data' => ['enabled' => $enabled],
    ]);
});

$router->add('POST', '#^/admin/insecure-approval$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $enabledRaw = $payload['enabled'] ?? null;
    $enabled = normalizeBoolean($enabledRaw);
    if ($enabled === null) {
        Response::json([
            'status' => 'error',
            'message' => 'enabled must be boolean',
        ], 422);
    }

    $versionRepository->set('insecure_approval_enabled', $enabled ? '1' : '0');
    $logRepository->log(null, 'admin.insecure_approval', [
        'enabled' => $enabled,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => ['enabled' => $enabled],
    ]);
});

$router->add('POST', '#^/admin/codex-version$#', function () use ($payload, $versionRepository, $service, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $selectionRaw = $payload['selection'] ?? null;
    if (!is_string($selectionRaw) || trim($selectionRaw) === '') {
        Response::json([
            'status' => 'error',
            'message' => 'selection must be one of: latest, or a version like 0.114.0',
        ], 422);
    }

    $selection = trim($selectionRaw);
    $selectionLower = strtolower($selection);
    $logSelection = 'latest';
    if ($selectionLower === 'latest' || $selectionLower === 'auto') {
        $versionRepository->delete('client_version_lock');
        // Opportunistically refresh the cached GitHub latest value so dashboards update quickly.
        $service->availableClientVersion(true);
    } else {
        $normalized = CodexVersionPolicy::normalize($selection);
        if (!CodexVersionPolicy::isSemanticVersion($normalized)) {
            Response::json([
                'status' => 'error',
                'message' => 'selection must be a semantic version like 0.114.0',
            ], 422);
        }
        $effective = CodexVersionPolicy::resolveEffective($normalized, true)['version'];
        $versionRepository->set('client_version_lock', $effective);
        $logSelection = $effective;
    }

    $lock = $versionRepository->getWithMetadata('client_version_lock');
    $logRepository->log(null, 'admin.codex_version', [
        'selection' => $logSelection,
        'locked_version' => $lock['version'] ?? null,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'locked_version' => $lock['version'] ?? null,
            'locked_at' => $lock['updated_at'] ?? null,
        ],
    ]);
});

$router->add('GET', '#^/admin/quota-mode$#', function () use ($versionRepository) {
    requireAdminAccess();

    $hardFail = $versionRepository->getFlag('quota_hard_fail', true);
    $limitPercent = quotaLimitPercent($versionRepository);
    $weekPartition = quotaWeekPartition($versionRepository);

    Response::json([
        'status' => 'ok',
        'data' => [
            'hard_fail' => $hardFail,
            'limit_percent' => $limitPercent,
            'week_partition' => $weekPartition,
        ],
    ]);
});

$router->add('POST', '#^/admin/quota-mode$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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

    $partitionRaw = $payload['week_partition'] ?? null;
    $weekPartition = $partitionRaw === null
        ? quotaWeekPartition($versionRepository)
        : AuthService::normalizeQuotaWeekPartition($partitionRaw);
    if ($partitionRaw !== null && $weekPartition === null) {
        Response::json([
            'status' => 'error',
            'message' => 'week_partition must be one of: off, 7, 5',
        ], 422);
    }

    $versionRepository->set('quota_hard_fail', $hardFail ? '1' : '0');
    $versionRepository->set('quota_limit_percent', (string) $limitPercent);
    $versionRepository->set('quota_week_partition', (string) $weekPartition);
    $logRepository->log(null, 'admin.quota_mode', [
        'hard_fail' => $hardFail,
        'limit_percent' => $limitPercent,
        'week_partition' => $weekPartition,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'hard_fail' => $hardFail,
            'limit_percent' => $limitPercent,
            'week_partition' => $weekPartition,
        ],
    ]);
});

$router->add('POST', '#^/admin/prune-policy$#', function () use ($payload, $versionRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $daysRaw = $payload['inactivity_days'] ?? null;
    if (!is_numeric($daysRaw)) {
        Response::json([
            'status' => 'error',
            'message' => 'inactivity_days must be an integer between 0 and 60',
        ], 422);
    }

    $days = (int) $daysRaw;
    if ($days < 0) {
        $days = 0;
    } elseif ($days > 60) {
        $days = 60;
    }

    $versionRepository->set('inactivity_window_days', (string) $days);
    $logRepository->log(null, 'admin.prune_policy', [
        'inactivity_window_days' => $days,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'inactivity_window_days' => $days,
        ],
    ]);
});

$router->add('GET', '#^/admin/hosts/(\d+)/auth$#', function ($hostId) use ($hostRepository, $hostStateRepository, $authPayloadRepository, $service, $digestRepository) {
    requireAdminAccess();
    $hostId = (int) $hostId;
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
                'ip4' => $host['ip4'] ?? null,
                'ip6' => $host['ip6'] ?? null,
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

$router->add('DELETE', '#^/admin/hosts/(\d+)$#', function ($hostId) use ($hostRepository, $digestRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
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

$router->add('POST', '#^/admin/hosts/(\d+)/clear$#', function ($hostId) use ($hostRepository, $digestRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
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

$router->add('POST', '#^/admin/hosts/(\d+)/roaming$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
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

$router->add('POST', '#^/admin/hosts/(\d+)/secure$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
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

$router->add('POST', '#^/admin/hosts/(\d+)/vip$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
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

$router->add('POST', '#^/admin/hosts/(\\d+)/auto-update$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    // Accept true, false, or null (null = follow fleet default).
    $overrideRaw = $payload['override'] ?? null;
    $override = null;
    if ($overrideRaw !== null) {
        $override = normalizeBoolean($overrideRaw);
        if ($override === null) {
            Response::json([
                'status' => 'error',
                'message' => 'override must be boolean or null',
            ], 422);
        }
    }

    $hostRepository->updateAutoUpdateOverride($hostId, $override);
    $logRepository->log($hostId, 'admin.host.auto_update', [
        'fqdn' => $host['fqdn'],
        'override' => $override,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => (int) $host['id'],
                'fqdn' => $host['fqdn'],
                'auto_update_override' => $override,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/insecure/enable$#', function ($hostId) use ($hostRepository, $logRepository, $payload, $service) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
    $hostId = (int) $hostId;
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
    $graceUntil = $service->resolveInsecureGraceUntil($enabledUntil, $minutes);
    $hostRepository->updateInsecureWindows($hostId, $enabledUntil, $graceUntil, $minutes);
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
                'insecure_grace_until' => $graceUntil,
                'insecure_window_minutes' => $minutes,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/insecure/disable$#', function ($hostId) use ($hostRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
    $hostId = (int) $hostId;
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

$router->add('POST', '#^/admin/insecure-approvals/(\\d+)/allow-domain$#', function ($requestId) use ($payload, $insecureAuthRequestRepository, $insecureDomainAllowRepository, $hostRepository, $logRepository, $service) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $requestId = (int) $requestId;
    $request = $insecureAuthRequestRepository->findById($requestId);
    if (!$request) {
        Response::json([
            'status' => 'error',
            'message' => 'Request not found',
        ], 404);
    }

    if (($request['status'] ?? '') !== 'pending') {
        Response::json([
            'status' => 'error',
            'message' => 'Request already resolved',
        ], 409);
    }

    $hostId = (int) ($request['host_id'] ?? 0);
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

    $normalizeDomain = static function (?string $domain): ?string {
        if (!is_string($domain)) {
            return null;
        }
        $normalized = strtolower(trim($domain));
        if ($normalized === '') {
            return null;
        }
        if (str_starts_with($normalized, '*.')) {
            $normalized = substr($normalized, 2);
        }
        $normalized = trim($normalized, '.');
        if ($normalized === '' || strpos($normalized, '.') === false) {
            return null;
        }
        if (preg_match('/\\s/', $normalized) === 1) {
            return null;
        }
        if (str_contains($normalized, '..')) {
            return null;
        }
        return $normalized;
    };

    $resolveParentDomain = static function (?string $fqdn) use ($normalizeDomain): ?string {
        if (!is_string($fqdn)) {
            return null;
        }
        $trimmed = strtolower(trim($fqdn));
        if ($trimmed === '') {
            return null;
        }
        $parts = array_values(array_filter(explode('.', $trimmed), static fn(string $part): bool => $part !== ''));
        if (count($parts) < 3) {
            return null;
        }
        return $normalizeDomain(implode('.', array_slice($parts, 1)));
    };

    $domain = $normalizeDomain($payload['domain'] ?? null) ?? $resolveParentDomain($host['fqdn'] ?? null);
    if ($domain === null) {
        Response::json([
            'status' => 'error',
            'message' => 'Domain must be a subdomain like cluster.example.com',
        ], 422);
    }

    $hostFqdn = strtolower(trim((string) ($host['fqdn'] ?? '')));
    $suffix = '.' . $domain;
    if ($hostFqdn === '' || strlen($hostFqdn) <= strlen($suffix) || substr($hostFqdn, -strlen($suffix)) !== $suffix) {
        Response::json([
            'status' => 'error',
            'message' => 'Domain must be a parent of the host FQDN',
        ], 422);
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

    $domainEnabledUntil = gmdate(DATE_ATOM, time() + ($minutes * 60));
    $domainAllow = $insecureDomainAllowRepository->upsert($domain, $minutes, $domainEnabledUntil);
    $logRepository->log($hostId, 'admin.insecure.domain_allow', [
        'fqdn' => $host['fqdn'],
        'domain' => $domain,
        'domain_id' => $domainAllow['id'] ?? null,
        'enabled_until' => $domainEnabledUntil,
        'window_minutes' => $minutes,
        'request_id' => $requestId,
    ]);

    $now = time();
    $currentEnabled = $host['insecure_enabled_until'] ?? null;
    $baseTs = $now;
    if (is_string($currentEnabled) && trim($currentEnabled) !== '') {
        $ts = strtotime($currentEnabled);
        if ($ts !== false && $ts > $now) {
            $baseTs = $ts;
        }
    }

    $enabledUntil = gmdate(DATE_ATOM, $baseTs + ($minutes * 60));
    $graceUntil = $service->resolveInsecureGraceUntil($enabledUntil, $minutes);
    $hostRepository->updateInsecureWindows($hostId, $enabledUntil, $graceUntil, $minutes);
    $logRepository->log($hostId, 'admin.host.insecure_enable', [
        'fqdn' => $host['fqdn'],
        'enabled_until' => $enabledUntil,
        'window_minutes' => $minutes,
        'source' => 'approval_domain',
        'request_id' => $requestId,
    ]);

    $insecureAuthRequestRepository->markApproved($requestId);
    $logRepository->log($hostId, 'admin.insecure.approval', [
        'fqdn' => $host['fqdn'],
        'request_id' => $requestId,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'request' => [
                'id' => $requestId,
                'status' => 'approved',
            ],
            'host' => [
                'id' => $hostId,
                'insecure_enabled_until' => $enabledUntil,
                'insecure_grace_until' => $graceUntil,
                'insecure_window_minutes' => $minutes,
            ],
            'domain' => [
                'id' => $domainAllow['id'] ?? null,
                'domain' => $domain,
                'enabled_until' => $domainEnabledUntil,
                'window_minutes' => $minutes,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/insecure-approvals/(\\d+)/approve$#', function ($requestId) use ($payload, $insecureAuthRequestRepository, $hostRepository, $logRepository, $service) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);

    $requestId = (int) $requestId;
    $request = $insecureAuthRequestRepository->findById($requestId);
    if (!$request) {
        Response::json([
            'status' => 'error',
            'message' => 'Request not found',
        ], 404);
    }

    if (($request['status'] ?? '') !== 'pending') {
        Response::json([
            'status' => 'error',
            'message' => 'Request already resolved',
        ], 409);
    }

    $hostId = (int) ($request['host_id'] ?? 0);
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
    $graceUntil = $service->resolveInsecureGraceUntil($enabledUntil, $minutes);
    $hostRepository->updateInsecureWindows($hostId, $enabledUntil, $graceUntil, $minutes);
    $logRepository->log($hostId, 'admin.host.insecure_enable', [
        'fqdn' => $host['fqdn'],
        'enabled_until' => $enabledUntil,
        'window_minutes' => $minutes,
        'source' => 'approval',
        'request_id' => $requestId,
    ]);

    $insecureAuthRequestRepository->markApproved($requestId);
    $logRepository->log($hostId, 'admin.insecure.approval', [
        'fqdn' => $host['fqdn'],
        'request_id' => $requestId,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'request' => [
                'id' => $requestId,
                'status' => 'approved',
            ],
            'host' => [
                'id' => $hostId,
                'insecure_enabled_until' => $enabledUntil,
                'insecure_grace_until' => $graceUntil,
                'insecure_window_minutes' => $minutes,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/insecure-approvals/(\\d+)/deny$#', function ($requestId) use ($insecureAuthRequestRepository, $hostRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);

    $requestId = (int) $requestId;
    $request = $insecureAuthRequestRepository->findById($requestId);
    if (!$request) {
        Response::json([
            'status' => 'error',
            'message' => 'Request not found',
        ], 404);
    }

    if (($request['status'] ?? '') !== 'pending') {
        Response::json([
            'status' => 'error',
            'message' => 'Request already resolved',
        ], 409);
    }

    $hostId = (int) ($request['host_id'] ?? 0);
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $insecureAuthRequestRepository->markDenied($requestId);
    $logRepository->log($hostId, 'admin.insecure.denied', [
        'fqdn' => $host['fqdn'],
        'request_id' => $requestId,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'request' => [
                'id' => $requestId,
                'status' => 'denied',
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/insecure-domain-allows/(\d+)/revoke$#', function ($allowId) use ($insecureDomainAllowRepository, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $allowId = (int) $allowId;
    $allow = $insecureDomainAllowRepository->findById($allowId);
    if (!$allow) {
        Response::json([
            'status' => 'error',
            'message' => 'Domain allow not found',
        ], 404);
    }

    $insecureDomainAllowRepository->markRevoked($allowId);
    $logRepository->log(null, 'admin.insecure.domain_revoke', [
        'domain' => $allow['domain'] ?? null,
        'domain_id' => $allowId,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'domain' => [
                'id' => $allowId,
                'domain' => $allow['domain'] ?? null,
                'revoked_at' => gmdate(DATE_ATOM),
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/ipv4$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
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
                'ip4' => null,
                'ip6' => null,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/curl-insecure$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $allowRaw = $payload['allow'] ?? null;
    $allow = normalizeBoolean($allowRaw);
    if (!is_bool($allow)) {
        Response::json([
            'status' => 'error',
            'message' => 'allow must be boolean',
        ], 422);
    }

    $hostRepository->updateCurlInsecure($hostId, $allow);
    $logRepository->log($hostId, 'admin.host.curl_insecure', [
        'fqdn' => $host['fqdn'] ?? null,
        'curl_insecure' => $allow,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'curl_insecure' => $allow,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/reverse-dns$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    if (!array_key_exists('mode', $payload)) {
        Response::json([
            'status' => 'error',
            'message' => 'mode is required',
        ], 422);
    }

    $mode = normalizeReverseDnsModeInput($payload['mode']);
    if ($mode === null) {
        Response::json([
            'status' => 'error',
            'message' => 'mode must be one of: global, enabled, disabled',
        ], 422);
    }

    $enabled = $mode === 'global' ? null : ($mode === 'enabled');
    $hostRepository->updateReverseDnsMode($hostId, $enabled);
    $logRepository->log($hostId, 'admin.host.reverse_dns', [
        'fqdn' => $host['fqdn'] ?? null,
        'reverse_dns_mode' => $mode,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'reverse_dns_mode' => $mode,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/model$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $modelRaw = $payload['model_override'] ?? null;
    $reasoningRaw = $payload['reasoning_effort_override'] ?? null;
    if ($modelRaw !== null && !is_string($modelRaw)) {
        Response::json([
            'status' => 'error',
            'message' => 'model_override must be string or null',
        ], 422);
    }
    if ($reasoningRaw !== null && !is_string($reasoningRaw)) {
        Response::json([
            'status' => 'error',
            'message' => 'reasoning_effort_override must be string or null',
        ], 422);
    }

    $modelOverride = ClientConfigService::normalizeSupportedModel($modelRaw);
    if (is_string($modelRaw) && trim($modelRaw) !== '' && $modelOverride === null) {
        Response::json([
            'status' => 'error',
            'message' => 'model_override must be one of: ' . implode(', ', ClientConfigService::supportedModels()),
        ], 422);
    }

    $reasoningOverride = ClientConfigService::normalizeReasoningEffort($reasoningRaw);
    if (is_string($reasoningRaw) && trim($reasoningRaw) !== '' && $reasoningOverride === null) {
        Response::json([
            'status' => 'error',
            'message' => 'reasoning_effort_override must be one of: ' . implode(', ', ClientConfigService::REASONING_EFFORTS),
        ], 422);
    }

    if ($modelOverride !== null && $reasoningOverride !== null
        && !ClientConfigService::modelSupportsReasoningEffort($modelOverride, $reasoningOverride)) {
        Response::json([
            'status' => 'error',
            'message' => 'reasoning_effort_override for ' . $modelOverride
                . ' must be one of: ' . implode(', ', ClientConfigService::supportedReasoningEffortsForModel($modelOverride)),
        ], 422);
    }

    $hostRepository->updateModelOverrides(
        $hostId,
        $modelOverride,
        $reasoningOverride
    );
    $logRepository->log($hostId, 'admin.host.model_overrides', [
        'fqdn' => $host['fqdn'] ?? null,
        'model_override' => $modelOverride,
        'reasoning_effort_override' => $reasoningOverride,
    ]);

    $updated = $hostRepository->findById($hostId);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'model_override' => $updated['model_override'] ?? null,
                'reasoning_effort_override' => $updated['reasoning_effort_override'] ?? null,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/codex-version$#', function ($hostId) use ($hostRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $selectionRaw = $payload['selection'] ?? ($payload['client_version_override'] ?? null);
    if ($selectionRaw !== null && !is_string($selectionRaw)) {
        Response::json([
            'status' => 'error',
            'message' => 'selection must be one of: global, or a version like 0.114.0',
        ], 422);
    }

    $selection = is_string($selectionRaw) ? trim($selectionRaw) : 'global';
    $selectionLower = strtolower($selection);
    if ($selectionLower === '' || $selectionLower === 'global' || $selectionLower === 'fleet' || $selectionLower === 'default') {
        $hostRepository->updateClientVersionOverride($hostId, null);
    } else {
        $normalized = CodexVersionPolicy::normalize($selection);
        if (!CodexVersionPolicy::isSemanticVersion($normalized)) {
            Response::json([
                'status' => 'error',
                'message' => 'selection must be a semantic version like 0.114.0',
            ], 422);
        }
        $effective = CodexVersionPolicy::resolveEffective($normalized, true)['version'];
        $hostRepository->updateClientVersionOverride($hostId, $effective);
    }

    $updated = $hostRepository->findById($hostId);
    $override = $updated['client_version_override'] ?? null;

    $logRepository->log($hostId, 'admin.host.client_version_override', [
        'fqdn' => $host['fqdn'] ?? null,
        'client_version_override' => $override,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'client_version_override' => $override,
            ],
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/(\\d+)/agents-version$#', function ($hostId) use ($hostRepository, $agentsRepository, $logRepository, $payload) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
    $hostId = (int) $hostId;
    $host = $hostRepository->findById($hostId);
    if (!$host) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    $selectionRaw = $payload['selection'] ?? ($payload['agents_document_id_override'] ?? null);
    if ($selectionRaw !== null && !is_string($selectionRaw) && !is_numeric($selectionRaw)) {
        Response::json([
            'status' => 'error',
            'message' => 'selection must be global or a numeric agents document id',
        ], 422);
    }

    $selection = is_string($selectionRaw) ? trim($selectionRaw) : $selectionRaw;
    $selectionLower = is_string($selection) ? strtolower($selection) : null;
    if ($selection === null || $selection === '' || $selectionLower === 'global' || $selectionLower === 'fleet' || $selectionLower === 'default') {
        $hostRepository->updateAgentsDocumentOverride($hostId, null);
    } else {
        $selectionId = is_numeric($selection) ? (int) $selection : 0;
        if ($selectionId <= 0) {
            Response::json([
                'status' => 'error',
                'message' => 'selection must be a valid agents document id',
            ], 422);
        }
        $version = $agentsRepository->findById($selectionId);
        if ($version === null) {
            Response::json([
                'status' => 'error',
                'message' => 'agents document id not found',
            ], 422);
        }
        $hostRepository->updateAgentsDocumentOverride($hostId, $selectionId);
    }

    $updated = $hostRepository->findById($hostId);
    $overrideId = $updated['agents_document_id_override'] ?? null;

    $logRepository->log($hostId, 'admin.host.agents_version_override', [
        'fqdn' => $host['fqdn'] ?? null,
        'agents_document_id_override' => $overrideId,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'host' => [
                'id' => $hostId,
                'agents_document_id_override' => $overrideId !== null ? (int) $overrideId : null,
            ],
        ],
    ]);
});

$router->add('GET', '#^/admin/overview$#', function () use ($hostRepository, $logRepository, $service, $tokenUsageRepository, $chatGptUsageService, $pricingService, $versionRepository, $pricingModel) {
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
    $pricing = $pricingService->latestPricing($pricingModel, false);
    $dailyCost = $pricingService->calculateCost($pricing, $tokensDay);
    $monthlyCost = $pricingService->calculateCost($pricing, $tokensMonth);
    $weeklyCost = $pricingService->calculateCost($pricing, $tokensWeek);
    $moneyEnv = static function (mixed $value): ?float {
        if ($value === null) {
            return null;
        }
        if (is_string($value)) {
            $trim = trim($value);
            if ($trim === '' || !is_numeric($trim)) {
                return null;
            }
            return (float) $trim;
        }
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }
        return null;
    };
    $planCurrency = is_array($pricing) && isset($pricing['currency']) && is_string($pricing['currency']) && $pricing['currency'] !== ''
        ? strtoupper($pricing['currency'])
        : strtoupper((string) Config::get('PRICING_CURRENCY', 'USD'));
    $subscriptionPlans = [
        'currency' => $planCurrency,
        'plus_cost' => $moneyEnv(Config::get('CHATGPT_PLUS_PLAN_COST', 20)) ?? 20.0,
        'pro_cost' => $moneyEnv(Config::get('CHATGPT_PRO_PLAN_COST', 200)) ?? 200.0,
    ];
    $quotaHardFail = $versionRepository->getFlag('quota_hard_fail', true);
    $quotaLimitPercent = quotaLimitPercent($versionRepository);
    $quotaWeekPartition = quotaWeekPartition($versionRepository);
    $cdxSilent = $versionRepository->getFlag('cdx_silent', false);
    $reverseDnsEnabled = $versionRepository->getFlag('reverse_dns_enabled', false);
    $insecureApprovalEnabled = $versionRepository->getFlag('insecure_approval_enabled', false);
    $autoUpdateEnabled = $versionRepository->getFlag('auto_update_enabled', false);
    $inactivityWindowDays = inactivityWindowDays($versionRepository);
    $clientVersionLock = $versionRepository->getWithMetadata('client_version_lock');
    $chatgptSummary = $chatGptUsageService->latestWindowSummary();
    if (is_array($chatgptSummary)) {
        $globalLaneSpark = modelUsesSparkQuotaLane($versionRepository->get('cdx_model'));
        if ($globalLaneSpark !== null) {
            $chatgptSummary['active_quota_lane'] = $globalLaneSpark ? 'spark' : 'normal';
        }
    }

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
            'subscription_plans' => $subscriptionPlans,
            'chatgpt_usage' => $chatgpt['snapshot'] ?? null,
            'chatgpt_usage_summary' => $chatgptSummary,
            'chatgpt_cached' => $chatgpt['cached'] ?? false,
            'chatgpt_next_eligible_at' => $chatgpt['next_eligible_at'] ?? null,
            'quota_hard_fail' => $quotaHardFail,
            'quota_limit_percent' => $quotaLimitPercent,
            'quota_week_partition' => $quotaWeekPartition,
            'cdx_silent' => $cdxSilent,
            'reverse_dns_enabled' => $reverseDnsEnabled,
            'insecure_approval_enabled' => $insecureApprovalEnabled,
            'auto_update_enabled' => $autoUpdateEnabled,
            'inactivity_window_days' => $inactivityWindowDays,
            'client_version_lock' => $clientVersionLock['version'] ?? null,
            'client_version_lock_updated_at' => $clientVersionLock['updated_at'] ?? null,
        ],
    ]);
});

$router->add('GET', '#^/admin/ws/info$#', function () use ($adminEventRepository) {
    requireAdminAccess();

    $enabled = normalizeBoolean(Config::get('ADMIN_WS_ENABLED', '0'));
    $enabled = $enabled ?? false;

    $url = null;
    if ($enabled) {
        $publicUrl = Config::get('ADMIN_WS_PUBLIC_URL', '');
        if (is_string($publicUrl)) {
            $publicUrl = trim($publicUrl);
            if ($publicUrl !== '' && preg_match('#^wss?://#', $publicUrl) === 1) {
                $url = $publicUrl;
            }
        }

        if ($url === null) {
            $baseUrl = resolveBaseUrl();
            if ($baseUrl !== '') {
                $wsUrl = rtrim($baseUrl, '/') . '/admin/ws';
                if (str_starts_with($wsUrl, 'https://')) {
                    $wsUrl = 'wss://' . substr($wsUrl, 8);
                } elseif (str_starts_with($wsUrl, 'http://')) {
                    $wsUrl = 'ws://' . substr($wsUrl, 7);
                }
                $url = $wsUrl;
            }
        }
    }

    $heartbeatRaw = Config::get('ADMIN_WS_PING_INTERVAL', 25);
    $heartbeat = is_numeric($heartbeatRaw) ? (int) $heartbeatRaw : 25;
    if ($heartbeat < 5) {
        $heartbeat = 5;
    }
    $backlogRaw = Config::get('ADMIN_WS_BACKLOG_LIMIT', 200);
    $backlog = is_numeric($backlogRaw) ? (int) $backlogRaw : 200;
    if ($backlog < 1) {
        $backlog = 1;
    } elseif ($backlog > 500) {
        $backlog = 500;
    }

    Response::json([
        'status' => 'ok',
        'data' => [
            'enabled' => (bool) $enabled,
            'url' => $url,
            'last_event_id' => $enabled ? $adminEventRepository->latestId() : 0,
            'heartbeat_seconds' => $heartbeat,
            'backlog_limit' => $backlog,
        ],
    ]);
});

$router->add('POST', '#^/admin/toasts$#', function () use ($payload, $adminEventRepository, $logRepository) {
    requireAdminAccess();

    $message = $payload['message'] ?? ($payload['body'] ?? ($payload['text'] ?? null));
    if (!is_string($message)) {
        Response::json([
            'status' => 'error',
            'message' => 'message is required',
        ], 422);
    }
    $message = trim($message);
    if ($message === '') {
        Response::json([
            'status' => 'error',
            'message' => 'message is required',
        ], 422);
    }
    if (strlen($message) > 500) {
        $message = substr($message, 0, 500);
    }

    $title = $payload['title'] ?? null;
    if (!is_string($title) || trim($title) === '') {
        $title = null;
    } else {
        $title = trim($title);
        if (strlen($title) > 120) {
            $title = substr($title, 0, 120);
        }
    }

    $levelRaw = $payload['level'] ?? ($payload['tone'] ?? 'info');
    $levelRaw = is_string($levelRaw) ? strtolower(trim($levelRaw)) : 'info';
    $level = match ($levelRaw) {
        'ok', 'success' => 'success',
        'warning', 'warn' => 'warn',
        'error', 'fail', 'danger' => 'error',
        default => 'info',
    };

    $timeoutRaw = $payload['timeout_ms'] ?? ($payload['timeoutMs'] ?? null);
    $timeoutMs = null;
    if (is_numeric($timeoutRaw)) {
        $timeoutMs = (int) $timeoutRaw;
        if ($timeoutMs < 1000) {
            $timeoutMs = 1000;
        } elseif ($timeoutMs > 20000) {
            $timeoutMs = 20000;
        }
    }

    $toastPayload = [
        'message' => $message,
        'title' => $title,
        'level' => $level,
        'timeout_ms' => $timeoutMs,
    ];

    $event = $adminEventRepository->append('toast', $toastPayload, null);
    $logRepository->log(null, 'admin.toast', [
        'level' => $level,
        'title' => $title,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'event' => $event,
        ],
    ]);
});

$router->add('GET', '#^/admin/hosts$#', function () use ($hostRepository, $digestRepository, $tokenUsageRepository, $service, $hostUserRepository, $authPayloadRepository, $versionRepository) {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    requireAdminAccess();
    $service->pruneStaleHosts();

    $canonicalDigest = null;
    $canonicalSourceHostId = null;
    $canonicalPayloadId = $versionRepository->get('canonical_payload_id');
    if ($canonicalPayloadId !== null && ctype_digit((string) $canonicalPayloadId)) {
        $canonicalPayload = $authPayloadRepository->findByIdWithEntries((int) $canonicalPayloadId);
        if ($canonicalPayload !== null && isset($canonicalPayload['sha256'])) {
            $canonicalDigest = $canonicalPayload['sha256'];
            $rawSourceHostId = $canonicalPayload['source_host_id'] ?? null;
            if ($rawSourceHostId !== null && is_numeric($rawSourceHostId)) {
                $canonicalSourceHostId = (int) $rawSourceHostId;
                if ($canonicalSourceHostId <= 0) {
                    $canonicalSourceHostId = null;
                }
            }
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
            'client_version_override' => $host['client_version_override'] ?? null,
            'agents_document_id_override' => isset($host['agents_document_id_override']) && $host['agents_document_id_override'] !== null
                ? (int) $host['agents_document_id_override']
                : null,
            'wrapper_version' => $host['wrapper_version'] ?? null,
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
            'ip4' => $host['ip4'] ?? null,
            'ip6' => $host['ip6'] ?? null,
            'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
            'secure' => isset($host['secure']) ? (bool) (int) $host['secure'] : true,
            'vip' => isset($host['vip']) ? (bool) (int) $host['vip'] : false,
            'insecure_enabled_until' => $normalizeTs($host['insecure_enabled_until'] ?? null),
            'insecure_grace_until' => $normalizeTs($host['insecure_grace_until'] ?? null),
            'insecure_window_minutes' => isset($host['insecure_window_minutes']) && $host['insecure_window_minutes'] !== null
                ? (int) $host['insecure_window_minutes']
                : null,
            'force_ipv4' => isset($host['force_ipv4']) ? (bool) (int) $host['force_ipv4'] : false,
            'curl_insecure' => isset($host['curl_insecure']) ? (bool) (int) $host['curl_insecure'] : false,
            'last_cron_check' => $normalizeTs($host['last_cron_check'] ?? null),
            'reverse_dns_mode' => formatReverseDnsModeOutput($host['reverse_dns_mode'] ?? null),
            'lane_preference' => AuthService::normalizeQuotaLane($host['lane_preference'] ?? null),
            'model_override' => $host['model_override'] ?? null,
            'reasoning_effort_override' => $host['reasoning_effort_override'] ?? null,
            'auto_update_override' => isset($host['auto_update_override']) ? ($host['auto_update_override'] === null ? null : (bool) (int) $host['auto_update_override']) : null,
            'canonical_digest' => $host['auth_digest'] ?? null,
            'recent_digests' => array_values(array_unique($hostDigests)),
            'authed' => ($host['auth_digest'] ?? '') !== '',
            'auth_outdated' => $canonicalDigest !== null
                && isset($host['auth_digest'])
                && (string) $host['auth_digest'] !== (string) $canonicalDigest,
            'auth_source' => $canonicalSourceHostId !== null && (int) $host['id'] === $canonicalSourceHostId,
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

$router->add('GET', '#^/admin/hosts/insecure$#', function () use ($hostRepository, $insecureDomainAllowRepository, $service) {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    requireAdminAccess();
    $service->pruneStaleHosts();

    $hosts = $hostRepository->all();

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

    $items = [];
    $active = 0;
    foreach ($hosts as $host) {
        $isSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        if ($isSecure) {
            continue;
        }

        $enabledUntil = $normalizeTs($host['insecure_enabled_until'] ?? null);
        $enabledTs = null;
        if (is_string($enabledUntil) && trim($enabledUntil) !== '') {
            $ts = strtotime($enabledUntil);
            if ($ts !== false) {
                $enabledTs = $ts;
            }
        }

        $isActive = ($enabledTs !== null) && ($enabledTs > time());
        if (!$isActive) {
            continue;
        }

        $active += 1;

        $items[] = [
            'id' => (int) $host['id'],
            'fqdn' => $host['fqdn'],
            'active' => true,
            'insecure_enabled_until' => $enabledUntil,
            'secure' => $isSecure,
        ];
    }

    usort($items, static function (array $a, array $b): int {
        if ($a['active'] !== $b['active']) {
            return $a['active'] ? -1 : 1;
        }
        return strcasecmp((string) ($a['fqdn'] ?? ''), (string) ($b['fqdn'] ?? ''));
    });

    $domainItems = [];
    $domainsActive = 0;
    $domainRows = $insecureDomainAllowRepository->listAll();
    foreach ($domainRows as $row) {
        if (!empty($row['revoked_at'])) {
            continue;
        }
        $enabledUntil = $normalizeTs($row['enabled_until'] ?? null);
        $enabledTs = null;
        if (is_string($enabledUntil) && trim($enabledUntil) !== '') {
            $ts = strtotime($enabledUntil);
            if ($ts !== false) {
                $enabledTs = $ts;
            }
        }
        $isActive = ($enabledTs !== null) && ($enabledTs > time());
        if (!$isActive) {
            continue;
        }

        $domainsActive += 1;
        $domainItems[] = [
            'id' => (int) ($row['id'] ?? 0),
            'domain' => $row['domain'] ?? null,
            'active' => true,
            'enabled_until' => $enabledUntil,
            'window_minutes' => isset($row['window_minutes']) ? (int) $row['window_minutes'] : null,
        ];
    }

    usort($domainItems, static function (array $a, array $b): int {
        if ($a['active'] !== $b['active']) {
            return $a['active'] ? -1 : 1;
        }
        return strcasecmp((string) ($a['domain'] ?? ''), (string) ($b['domain'] ?? ''));
    });

    Response::json([
        'status' => 'ok',
        'data' => [
            'count' => count($items),
            'active' => $active,
            'hosts' => $items,
            'domains' => $domainItems,
            'domains_active' => $domainsActive,
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/insecure/extend$#', function () use ($hostRepository, $service, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
    $service->pruneStaleHosts();

    $hosts = $hostRepository->all();
    $now = time();
    $extended = 0;

    foreach ($hosts as $host) {
        $isSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        if ($isSecure) {
            continue;
        }

        $enabledUntil = $host['insecure_enabled_until'] ?? null;
        $enabledTs = is_string($enabledUntil) ? strtotime($enabledUntil) : false;
        $isActive = $enabledTs !== false && $enabledTs > $now;
        if (!$isActive) {
            continue;
        }

        $minutesRaw = $host['insecure_window_minutes'] ?? AuthService::DEFAULT_INSECURE_WINDOW_MINUTES;
        $minutes = (int) $minutesRaw;
        if ($minutes < AuthService::MIN_INSECURE_WINDOW_MINUTES) {
            $minutes = AuthService::MIN_INSECURE_WINDOW_MINUTES;
        } elseif ($minutes > AuthService::MAX_INSECURE_WINDOW_MINUTES) {
            $minutes = AuthService::MAX_INSECURE_WINDOW_MINUTES;
        }

        $newUntil = gmdate(DATE_ATOM, $now + ($minutes * 60));
        $graceUntil = $service->resolveInsecureGraceUntil($newUntil, $minutes);
        $hostRepository->updateInsecureWindows((int) $host['id'], $newUntil, $graceUntil, null);
        $logRepository->log((int) $host['id'], 'admin.host.insecure_extend', [
            'fqdn' => $host['fqdn'] ?? null,
            'enabled_until' => $newUntil,
            'window_minutes' => $minutes,
        ]);
        $extended += 1;
    }

    Response::json([
        'status' => 'ok',
        'data' => [
            'extended' => $extended,
        ],
    ]);
});

$router->add('POST', '#^/admin/hosts/insecure/disable-all$#', function () use ($hostRepository, $service, $logRepository) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
    $service->pruneStaleHosts();

    $hosts = $hostRepository->all();
    $now = time();
    $disabled = 0;

    foreach ($hosts as $host) {
        $isSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        if ($isSecure) {
            continue;
        }

        $enabledUntil = $host['insecure_enabled_until'] ?? null;
        $enabledTs = is_string($enabledUntil) ? strtotime($enabledUntil) : false;
        $isActive = $enabledTs !== false && $enabledTs > $now;
        if (!$isActive) {
            continue;
        }

        $hostRepository->updateInsecureWindows((int) $host['id'], null, null);
        $logRepository->log((int) $host['id'], 'admin.host.insecure_disable', [
            'fqdn' => $host['fqdn'] ?? null,
            'enabled_until' => null,
            'window_minutes' => $host['insecure_window_minutes'] ?? null,
        ]);
        $disabled += 1;
    }

    Response::json([
        'status' => 'ok',
        'data' => [
            'disabled' => $disabled,
        ],
    ]);
});

$router->add('GET', '#^/admin/logs$#', function () use ($logRepository) {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
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
    $from = resolveStringQuery('from');
    $until = resolveStringQuery('until');
    $interval = strtolower(resolveStringQuery('interval') ?? 'day');
    $groupBy = strtolower(resolveStringQuery('group_by') ?? 'component');
    $includeTokensRaw = resolveStringQuery('include_tokens');
    $includeTokens = true;

    if ($from !== null && strtotime($from) === false) {
        Response::json([
            'status' => 'error',
            'message' => 'Invalid from timestamp (expected RFC3339/date string)',
        ], 400);
    }
    if ($until !== null && strtotime($until) === false) {
        Response::json([
            'status' => 'error',
            'message' => 'Invalid until timestamp (expected RFC3339/date string)',
        ], 400);
    }
    if ($from !== null && $until !== null) {
        $fromTs = strtotime($from);
        $untilTs = strtotime($until);
        if ($fromTs !== false && $untilTs !== false && $fromTs > $untilTs) {
            Response::json([
                'status' => 'error',
                'message' => 'from must be before until',
            ], 400);
        }
    }
    if (!in_array($interval, ['day', 'week'], true)) {
        Response::json([
            'status' => 'error',
            'message' => 'interval must be one of: day, week',
        ], 400);
    }
    if (!in_array($groupBy, ['component', 'total'], true)) {
        Response::json([
            'status' => 'error',
            'message' => 'group_by must be one of: component, total',
        ], 400);
    }
    if ($includeTokensRaw !== null) {
        $normalizedIncludeTokens = normalizeBoolean($includeTokensRaw);
        if ($normalizedIncludeTokens === null) {
            Response::json([
                'status' => 'error',
                'message' => 'include_tokens must be a boolean-like value',
            ], 400);
        }
        $includeTokens = $normalizedIncludeTokens;
    }

    $history = $costHistoryService->historyAdvanced($days, $from, $until, $interval, $groupBy, $includeTokens);

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
    $from = resolveStringQuery('from');
    $until = resolveStringQuery('until');
    $interval = strtolower(resolveStringQuery('interval') ?? 'day');
    $lane = strtolower(resolveStringQuery('lane') ?? 'both');
    $window = strtolower(resolveStringQuery('window') ?? 'both');

    if ($from !== null && strtotime($from) === false) {
        Response::json([
            'status' => 'error',
            'message' => 'Invalid from timestamp (expected RFC3339/date string)',
        ], 400);
    }
    if ($until !== null && strtotime($until) === false) {
        Response::json([
            'status' => 'error',
            'message' => 'Invalid until timestamp (expected RFC3339/date string)',
        ], 400);
    }
    if ($from !== null && $until !== null) {
        $fromTs = strtotime($from);
        $untilTs = strtotime($until);
        if ($fromTs !== false && $untilTs !== false && $fromTs > $untilTs) {
            Response::json([
                'status' => 'error',
                'message' => 'from must be before until',
            ], 400);
        }
    }
    if (!in_array($interval, ['raw', 'hour', 'day'], true)) {
        Response::json([
            'status' => 'error',
            'message' => 'interval must be one of: raw, hour, day',
        ], 400);
    }
    if (!in_array($lane, ['normal', 'spark', 'both'], true)) {
        Response::json([
            'status' => 'error',
            'message' => 'lane must be one of: normal, spark, both',
        ], 400);
    }
    if (!in_array($window, ['primary', 'secondary', 'both'], true)) {
        Response::json([
            'status' => 'error',
            'message' => 'window must be one of: primary, secondary, both',
        ], 400);
    }

    $history = $chatGptUsageService->historyAdvanced($days, $from, $until, $interval, $lane, $window);

    Response::json([
        'status' => 'ok',
        'data' => $history,
    ]);
});

$router->add('POST', '#^/admin/chatgpt/usage/refresh$#', function () use ($chatGptUsageService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
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
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
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
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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

$router->add('POST', '#^/admin/agents/serve$#', function () use ($payload, $agentsService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $mode = is_array($payload) ? (string) ($payload['mode'] ?? '') : '';
    $versionId = null;
    if (is_array($payload) && isset($payload['version_id'])) {
        $versionId = is_numeric($payload['version_id']) ? (int) $payload['version_id'] : null;
    }

    try {
        $result = $agentsService->setServeMode($mode, $versionId);
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

$router->add('DELETE', '#^/admin/agents/versions/(\d+)$#', function ($versionId) use ($agentsService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    $versionId = (int) $versionId;

    try {
        $result = $agentsService->deleteVersion($versionId);
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

$router->add('DELETE', '#^/admin/mcp/memories/(\\d+)$#', function ($id) use ($memoryService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $id = (int) $id;
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

$router->add('GET', '#^/admin/slash-commands/([^/]+)$#', function ($filename) use ($slashCommandService) {
    requireAdminAccess();
    $filename = urldecode($filename);
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
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

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

$router->add('DELETE', '#^/admin/slash-commands/([^/]+)$#', function ($filename) use ($slashCommandService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $filename = urldecode($filename);
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

$router->add('GET', '#^/admin/skills$#', function () use ($skillService) {
    requireAdminAccess();

    $skills = $skillService->listSkills(null, true);

    Response::json([
        'status' => 'ok',
        'data' => ['skills' => $skills],
    ]);
});

$router->add('GET', '#^/admin/skills/([^/]+)$#', function ($slug) use ($skillService) {
    requireAdminAccess();
    $slug = urldecode($slug);
    try {
        $skill = $skillService->find($slug);
    } catch (ValidationException $exception) {
        Response::json([
            'status' => 'error',
            'message' => 'Validation failed',
            'errors' => $exception->getErrors(),
        ], 422);
    }

    if ($skill === null) {
        Response::json([
            'status' => 'error',
            'message' => 'Skill not found',
        ], 404);
    }

    Response::json([
        'status' => 'ok',
        'data' => $skill,
    ]);
});

$router->add('POST', '#^/admin/skills/store$#', function () use ($payload, $skillService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);

    try {
        $result = $skillService->store(is_array($payload) ? $payload : [], null);
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

$router->add('DELETE', '#^/admin/skills/([^/]+)$#', function ($slug) use ($skillService) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $slug = urldecode($slug);
    try {
        $deleted = $skillService->delete($slug);
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
            'message' => 'Skill not found',
        ], 404);
    }

    Response::json([
        'status' => 'ok',
        'data' => [
            'deleted' => $slug,
        ],
    ]);
});

$router->add('GET', '#^/admin/projects/state$#', function () use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($projectCoordinationService) {
        return $projectCoordinationService->adminState();
    });
});

$router->add('POST', '#^/admin/projects/state$#', function () use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($payload, $projectCoordinationService) {
        $enabled = normalizeBoolean(is_array($payload) ? ($payload['enabled'] ?? null) : null);
        if ($enabled === null) {
            throw new ValidationException(['enabled' => ['enabled must be true or false']]);
        }

        return $projectCoordinationService->setEnabled($enabled);
    });
});

$router->add('GET', '#^/admin/projects/feedback$#', function () use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($projectCoordinationService) {
        return $projectCoordinationService->listFeedback(null, null);
    });
});

$router->add('GET', '#^/admin/projects$#', function () use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($projectCoordinationService) {
        return $projectCoordinationService->listProjects(null);
    });
});

$router->add('POST', '#^/admin/projects$#', function () use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($payload, $projectCoordinationService) {
        return $projectCoordinationService->createProject(is_array($payload) ? $payload : [], null);
    });
});

$router->add('DELETE', '#^/admin/projects/([^/]+)$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        return $projectCoordinationService->deleteProject(urldecode($slug), null);
    });
});

$router->add('GET', '#^/admin/projects/([^/]+)$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    requireAdminAccess();
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        return $projectCoordinationService->projectDetail(urldecode($slug), null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/about$#', function ($slug) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService) {
        return $projectCoordinationService->updateAbout(urldecode($slug), is_array($payload) ? $payload : [], null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/roster$#', function ($slug) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService) {
        return $projectCoordinationService->updateRoster(urldecode($slug), is_array($payload) ? $payload : [], null);
    });
});

$router->add('GET', '#^/admin/projects/([^/]+)/changes$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        $since = resolveIntQuery('since') ?? 0;
        return $projectCoordinationService->listChanges(urldecode($slug), max(0, $since), null);
    });
});

$router->add('GET', '#^/admin/projects/([^/]+)/notes$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        return $projectCoordinationService->listNotes(urldecode($slug), null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/notes$#', function ($slug) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService) {
        return $projectCoordinationService->upsertNote(urldecode($slug), null, is_array($payload) ? $payload : [], null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/notes/(\\d+)$#', function ($slug, $id) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $payload, $projectCoordinationService) {
        return $projectCoordinationService->upsertNote(urldecode($slug), (int) $id, is_array($payload) ? $payload : [], null);
    });
});

$router->add('DELETE', '#^/admin/projects/([^/]+)/notes/(\\d+)$#', function ($slug, $id) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService) {
        return $projectCoordinationService->deleteNote(urldecode($slug), (int) $id, null);
    });
});

$router->add('GET', '#^/admin/projects/([^/]+)/todos$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        return $projectCoordinationService->listTodos(urldecode($slug), null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/todos$#', function ($slug) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService) {
        return $projectCoordinationService->createTodo(urldecode($slug), is_array($payload) ? $payload : [], null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/todos/(\\d+)$#', function ($slug, $id) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $payload, $projectCoordinationService) {
        return $projectCoordinationService->updateTodo(urldecode($slug), (int) $id, is_array($payload) ? $payload : [], null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/todos/(\\d+)/done$#', function ($slug, $id) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService) {
        return $projectCoordinationService->setTodoDone(urldecode($slug), (int) $id, true, null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/todos/(\\d+)/undone$#', function ($slug, $id) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService) {
        return $projectCoordinationService->setTodoDone(urldecode($slug), (int) $id, false, null);
    });
});

$router->add('DELETE', '#^/admin/projects/([^/]+)/todos/(\\d+)$#', function ($slug, $id) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService) {
        return $projectCoordinationService->deleteTodo(urldecode($slug), (int) $id, null);
    });
});

$router->add('GET', '#^/admin/projects/([^/]+)/files$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        return $projectCoordinationService->listFiles(urldecode($slug), null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/files$#', function ($slug) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService) {
        return $projectCoordinationService->upsertFile(urldecode($slug), is_array($payload) ? $payload : [], null);
    });
});

$router->add('DELETE', '#^/admin/projects/([^/]+)/files/(\\d+)$#', function ($slug, $id) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService) {
        return $projectCoordinationService->deleteFile(urldecode($slug), (int) $id, null);
    });
});

$router->add('GET', '#^/admin/projects/([^/]+)/feedback$#', function ($slug) use ($projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    $respondProjectAction(static function () use ($slug, $projectCoordinationService) {
        return $projectCoordinationService->listFeedback(urldecode($slug), null);
    });
});

$router->add('POST', '#^/admin/projects/([^/]+)/feedback$#', function ($slug) use ($payload, $projectCoordinationService, $respondProjectAction) {
    requireAdminAccess();
    requireAdminCapability(AdminAuthService::CAP_SETTINGS);
    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService) {
        return $projectCoordinationService->createFeedback(urldecode($slug), is_array($payload) ? $payload : [], null);
    });
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
    $host = $service->authenticate($apiKey, $clientIp, false, true);
    $clientVersion = extractClientVersion($payload);
    $wrapperVersion = extractWrapperVersion($payload);
    $baseUrl = resolveBaseUrl();

    // Opportunistically refresh ChatGPT usage if stale (respects cooldown inside service).
    $chatGptUsageService->fetchLatest(false);

    $result = $service->handleAuth(is_array($payload) ? $payload : [], $host, $clientVersion, $wrapperVersion, $baseUrl);
    $chatgptUsage = $chatGptUsageService->latestWindowSummary();
    if (is_array($chatgptUsage)) {
        $chatgptUsage['active_quota_lane'] = resolveActiveQuotaLaneForHost($host, $versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
    }
    $result['chatgpt_usage'] = $chatgptUsage;

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/sync/status$#', function () use ($payload, $service, $startupSyncService, $chatGptUsageService, $versionRepository) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp, false, true);
    $baseUrl = resolveBaseUrl();
    $requestPayload = is_array($payload) ? $payload : [];

    $hostUserInput = extractSyncHostUserInput($requestPayload);
    $users = $service->recordHostUser($host, $hostUserInput['username'], $hostUserInput['hostname']);

    $result = $startupSyncService->collect($requestPayload, $host, $baseUrl, $apiKey, false);
    $includeAuth = normalizeBoolean($requestPayload['include_auth'] ?? null);
    if ($includeAuth !== false) {
        $authFingerprint = extractSyncAuthFingerprint($requestPayload);
        $clientVersion = extractClientVersion($requestPayload);
        $wrapperVersion = extractWrapperVersion($requestPayload);
        $authResult = $service->handleAuth($authFingerprint, $host, $clientVersion, $wrapperVersion, $baseUrl);

        $chatGptUsageService->fetchLatest(false);
        $chatgptUsage = $chatGptUsageService->latestWindowSummary();
        if (is_array($chatgptUsage)) {
            $chatgptUsage['active_quota_lane'] = resolveActiveQuotaLaneForHost($host, $versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
        }
        $authResult['chatgpt_usage'] = $chatgptUsage;
        $result['auth'] = $authResult;

        $authStatus = strtolower(trim((string) ($authResult['status'] ?? '')));
        if ($authStatus !== 'valid') {
            $result['reasons'][] = 'auth_' . ($authStatus !== '' ? $authStatus : 'unknown');
        }
    }

    $result['reasons'] = array_values(array_unique(array_filter($result['reasons'] ?? [])));
    $result['status'] = $result['reasons'] === [] ? 'ok' : 'update';
    $result['host_users'] = $users;

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/sync/bootstrap$#', function () use ($payload, $service, $startupSyncService, $chatGptUsageService, $versionRepository) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp, false, true);
    $baseUrl = resolveBaseUrl();
    $requestPayload = is_array($payload) ? $payload : [];

    $hostUserInput = extractSyncHostUserInput($requestPayload);
    $users = $service->recordHostUser($host, $hostUserInput['username'], $hostUserInput['hostname']);

    $result = $startupSyncService->collect($requestPayload, $host, $baseUrl, $apiKey, true);
    $includeAuth = normalizeBoolean($requestPayload['include_auth'] ?? null);
    if ($includeAuth !== false) {
        $authFingerprint = extractSyncAuthFingerprint($requestPayload);
        $clientVersion = extractClientVersion($requestPayload);
        $wrapperVersion = extractWrapperVersion($requestPayload);
        $authResult = $service->handleAuth($authFingerprint, $host, $clientVersion, $wrapperVersion, $baseUrl);
        $authStatus = strtolower(trim((string) ($authResult['status'] ?? '')));
        $authCandidate = extractSyncAuthCandidate($requestPayload);
        $didStore = false;

        if (($authStatus === 'missing' || $authStatus === 'upload_required') && is_array($authCandidate)) {
            $storePayload = [
                'command' => 'store',
                'auth' => $authCandidate,
            ];
            if (isset($authResult['canonical_digest']) && is_string($authResult['canonical_digest']) && trim($authResult['canonical_digest']) !== '') {
                $storePayload['digest'] = trim((string) $authResult['canonical_digest']);
            }
            if (
                array_key_exists('session_started_at', $requestPayload)
                && is_string($requestPayload['session_started_at'])
                && trim($requestPayload['session_started_at']) !== ''
            ) {
                $storePayload['session_started_at'] = trim((string) $requestPayload['session_started_at']);
            }
            if (
                array_key_exists('installation_id', $requestPayload)
                && is_string($requestPayload['installation_id'])
                && trim($requestPayload['installation_id']) !== ''
            ) {
                $storePayload['installation_id'] = trim((string) $requestPayload['installation_id']);
            }

            $authResult = $service->handleAuth($storePayload, $host, $clientVersion, $wrapperVersion, $baseUrl);
            $authStatus = strtolower(trim((string) ($authResult['status'] ?? '')));
            $didStore = true;
        }

        $chatGptUsageService->fetchLatest(false);
        $chatgptUsage = $chatGptUsageService->latestWindowSummary();
        if (is_array($chatgptUsage)) {
            $chatgptUsage['active_quota_lane'] = resolveActiveQuotaLaneForHost($host, $versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
        }
        $authResult['chatgpt_usage'] = $chatgptUsage;
        $result['auth'] = $authResult;

        if ($didStore && ($authStatus === 'updated' || $authStatus === 'unchanged')) {
            $result['reasons'][] = 'auth_stored';
        } elseif ($authStatus !== 'valid') {
            $result['reasons'][] = 'auth_' . ($authStatus !== '' ? $authStatus : 'unknown');
        }
    }

    $result['reasons'] = array_values(array_unique(array_filter($result['reasons'] ?? [])));
    $result['status'] = $result['reasons'] === [] ? 'ok' : 'update';
    $result['host_users'] = $users;

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('DELETE', '#^/auth$#', function () use ($service) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $force = isset($_GET['force']) && $_GET['force'] !== '0';

    $host = $service->authenticate($apiKey, $clientIp, $force, true);
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
    $username = is_array($payload) && array_key_exists('username', $payload) ? (string) $payload['username'] : null;
    $home = is_array($payload) && array_key_exists('home', $payload) ? (string) $payload['home'] : null;
    $result = $clientConfigService->retrieve($sha, $host, $baseUrl, $apiKey, $username, $home);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('GET', '#^/projects$#', function () use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($projectCoordinationService, $host) {
        return $projectCoordinationService->listProjects($host);
    });
});

$router->add('POST', '#^/projects$#', function () use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->createProject(is_array($payload) ? $payload : [], $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)/bootstrap$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        return $projectCoordinationService->bootstrap(urldecode($slug), $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        return $projectCoordinationService->projectDetail(urldecode($slug), $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/about$#', function ($slug) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->updateAbout(urldecode($slug), is_array($payload) ? $payload : [], $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/roster$#', function ($slug) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->updateRoster(urldecode($slug), is_array($payload) ? $payload : [], $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)/changes$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        $since = resolveIntQuery('since') ?? 0;
        return $projectCoordinationService->listChanges(urldecode($slug), max(0, $since), $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)/notes$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        return $projectCoordinationService->listNotes(urldecode($slug), $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/notes$#', function ($slug) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->upsertNote(urldecode($slug), null, is_array($payload) ? $payload : [], $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/notes/(\\d+)$#', function ($slug, $id) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->upsertNote(urldecode($slug), (int) $id, is_array($payload) ? $payload : [], $host);
    });
});

$router->add('DELETE', '#^/projects/([^/]+)/notes/(\\d+)$#', function ($slug, $id) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService, $host) {
        return $projectCoordinationService->deleteNote(urldecode($slug), (int) $id, $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)/todos$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        return $projectCoordinationService->listTodos(urldecode($slug), $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/todos$#', function ($slug) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->createTodo(urldecode($slug), is_array($payload) ? $payload : [], $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/todos/(\\d+)$#', function ($slug, $id) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->updateTodo(urldecode($slug), (int) $id, is_array($payload) ? $payload : [], $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/todos/(\\d+)/done$#', function ($slug, $id) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService, $host) {
        return $projectCoordinationService->setTodoDone(urldecode($slug), (int) $id, true, $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/todos/(\\d+)/undone$#', function ($slug, $id) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService, $host) {
        return $projectCoordinationService->setTodoDone(urldecode($slug), (int) $id, false, $host);
    });
});

$router->add('DELETE', '#^/projects/([^/]+)/todos/(\\d+)$#', function ($slug, $id) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService, $host) {
        return $projectCoordinationService->deleteTodo(urldecode($slug), (int) $id, $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)/files$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        return $projectCoordinationService->listFiles(urldecode($slug), $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/files$#', function ($slug) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->upsertFile(urldecode($slug), is_array($payload) ? $payload : [], $host);
    });
});

$router->add('DELETE', '#^/projects/([^/]+)/files/(\\d+)$#', function ($slug, $id) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $id, $projectCoordinationService, $host) {
        return $projectCoordinationService->deleteFile(urldecode($slug), (int) $id, $host);
    });
});

$router->add('GET', '#^/projects/([^/]+)/feedback$#', function ($slug) use ($service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $projectCoordinationService, $host) {
        return $projectCoordinationService->listFeedback(urldecode($slug), $host);
    });
});

$router->add('POST', '#^/projects/([^/]+)/feedback$#', function ($slug) use ($payload, $service, $projectCoordinationService, $respondProjectAction) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $respondProjectAction(static function () use ($slug, $payload, $projectCoordinationService, $host) {
        return $projectCoordinationService->createFeedback(urldecode($slug), is_array($payload) ? $payload : [], $host);
    });
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

$router->add('POST', '#^/mcp/memories/delete$#', function () use ($payload, $service, $memoryService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $result = $memoryService->delete(is_array($payload) ? $payload : [], $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('DELETE', '#^/mcp/memories/([^/]+)$#', function ($id) use ($service, $memoryService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $id = rawurldecode($id);
    $result = $memoryService->delete(['id' => $id], $host);

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

$router->add('GET', '#^/skills$#', function () use ($service, $skillService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $skills = $skillService->listSkills($host, true);

    Response::json([
        'status' => 'ok',
        'data' => [
            'skills' => $skills,
        ],
    ]);
});

$router->add('POST', '#^/skills/retrieve$#', function () use ($payload, $service, $skillService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $slug = is_array($payload) ? (string) ($payload['slug'] ?? ($payload['filename'] ?? '')) : '';
    $sha = is_array($payload) && array_key_exists('sha256', $payload) ? (string) $payload['sha256'] : null;
    $result = $skillService->retrieve($slug, $sha, $host);

    Response::json([
        'status' => 'ok',
        'data' => $result,
    ]);
});

$router->add('POST', '#^/skills/store$#', function () use ($payload, $service, $skillService) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);

    $result = $skillService->store(is_array($payload) ? $payload : [], $host);

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

$router->add('GET', '#^/host/lane$#', function () use ($service, $versionRepository) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $host = $service->enforceInsecureWindow($host, 'host_lane_get');

    $lanePreference = AuthService::normalizeQuotaLane($host['lane_preference'] ?? null);
    $effectiveLane = resolveActiveQuotaLaneForHost($host, $versionRepository, $lanePreference);

    Response::json([
        'status' => 'ok',
        'data' => [
            'lane_preference' => $lanePreference,
            'effective_lane' => $effectiveLane,
            'host_id' => isset($host['id']) ? (int) $host['id'] : null,
            'fqdn' => $host['fqdn'] ?? null,
        ],
    ]);
});

$router->add('POST', '#^/host/lane$#', function () use ($payload, $service, $hostRepository, $logRepository, $versionRepository) {
    $apiKey = resolveApiKey();
    $clientIp = resolveClientIp();
    $host = $service->authenticate($apiKey, $clientIp);
    $host = $service->enforceInsecureWindow($host, 'host_lane_set');

    $hostId = isset($host['id']) ? (int) $host['id'] : 0;
    if ($hostId <= 0) {
        Response::json([
            'status' => 'error',
            'message' => 'Host not found',
        ], 404);
    }

    if (!is_array($payload) || !array_key_exists('lane', $payload)) {
        Response::json([
            'status' => 'error',
            'message' => 'lane is required (set null to clear)',
        ], 422);
    }

    $laneRaw = $payload['lane'];
    if ($laneRaw !== null && !is_string($laneRaw)) {
        Response::json([
            'status' => 'error',
            'message' => 'lane must be one of: normal, spark, or null',
        ], 422);
    }

    $lanePreference = AuthService::normalizeQuotaLane($laneRaw);
    if ($laneRaw !== null && is_string($laneRaw) && trim($laneRaw) !== '' && $lanePreference === null) {
        Response::json([
            'status' => 'error',
            'message' => 'lane must be one of: normal, spark, or null',
        ], 422);
    }

    $hostRepository->updateLanePreference($hostId, $lanePreference);
    $updated = $hostRepository->findById($hostId) ?? $host;
    $effectiveLane = resolveActiveQuotaLaneForHost($updated, $versionRepository, $lanePreference);
    $logRepository->log($hostId, 'host.lane.set', [
        'fqdn' => $updated['fqdn'] ?? ($host['fqdn'] ?? null),
        'lane_preference' => $lanePreference,
        'effective_lane' => $effectiveLane,
    ]);

    Response::json([
        'status' => 'ok',
        'data' => [
            'lane_preference' => $lanePreference,
            'effective_lane' => $effectiveLane,
            'host_id' => $hostId,
            'fqdn' => $updated['fqdn'] ?? ($host['fqdn'] ?? null),
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

    $host = $service->authenticateMcpCredential($apiKey, $clientIp);

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
                        'name' => 'codex-orchestrator',
                        'version' => $service->versionSummary()['wrapper_version'] ?? 'unknown',
                    ],
                ];
                break;

            case 'tools/list':
            case 'tools.list':
            case 'list_tools':
                $result = [
                    'tools' => $mcpServer->listTools(McpServer::CAPABILITY_HOST),
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

            case 'notifications/initialized':
            case 'notifications.initialized':
                // Optional MCP notification; acknowledge and do nothing.
                $result = ['ok' => true];
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
                    $result = $mcpServer->dispatch($name, $args, $host, McpServer::CAPABILITY_HOST);
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
