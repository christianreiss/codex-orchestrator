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
use App\DatabaseMigrator;
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
use App\Repositories\JoplinNoteRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\VersionRepository;
use App\Repositories\ProjectEventRepository;
use App\Repositories\ProjectFeedbackRepository;
use App\Repositories\ProjectFileRepository;
use App\Repositories\ProjectNoteRepository;
use App\Repositories\ProjectRepository;
use App\Repositories\ProjectTodoRepository;
use App\Repositories\AgentsRepository;
use App\Repositories\SkillRepository;
use App\Repositories\MemoryRepository;
use App\Repositories\ClientConfigRepository;
use App\Repositories\DashboardGraphStatsRepository;
use App\Repositories\McpAccessLogRepository;
use App\Repositories\McpSessionTokenRepository;
use App\Services\AuthService;
use App\Services\AdminAuthService;
use App\Services\AdminPasskeyService;
use App\Services\AdminUserService;
use App\Services\WrapperService;
use App\Services\RunnerVerifier;
use App\Services\RunnerValidationService;
use App\Services\ChatGptUsageService;
use App\Services\DashboardGraphStatsService;
use App\Services\ProjectCoordinationService;
use App\Services\ProjectDraftService;
use App\Services\ProjectModuleService;
use App\Services\AgentsService;
use App\Services\JoplinCacheService;
use App\Services\JoplinService;
use App\Services\JoplinSkillService;
use App\Services\SkillService;
use App\Services\SkillDraftService;
use App\Services\SkillManifestService;
use App\Services\SkillSummaryService;
use App\Services\MemoryService;
use App\Services\MemorySummaryService;
use App\Services\ClientConfigService;
use App\Services\OpenAiModelService;
use App\Services\ClaudeModelService;
use App\Services\ClaudeUsageService;
use App\Services\StartupSyncService;
use App\Services\UsageScalingService;
use App\Mcp\McpServer;
use App\Mcp\McpToolNotFoundException;
use App\Security\EncryptionKeyManager;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use App\Security\RateLimiter;
use App\Support\CodexVersionPolicy;
use App\Support\Installation;
use App\Support\Mailer;
use App\Http\Controllers\CronController;
use App\Http\Controllers\VersionController;
use App\Http\Controllers\AdminPageController;
use App\Http\Controllers\AdminAuthController;
use App\Http\Controllers\AdminUserController;
use App\Http\Controllers\AdminSettingsController;
use App\Http\Controllers\AdminHostController;
use App\Http\Controllers\AdminOverviewController;
use App\Http\Controllers\AdminConfigController;
use App\Http\Controllers\AdminProjectController;
use App\Http\Controllers\WrapperV2Controller;
use App\Http\Controllers\InstallV2Controller;
use App\Services\Wrapper\V2\BakeCache;
use App\Services\Wrapper\V2\BinaryRegistry;
use App\Services\Wrapper\V2\ConfigBaker;
use App\Services\Wrapper\V2\ConfigSigner;
use App\Support\Engine;
use App\Http\Controllers\AuthController;
use App\Http\Controllers\ConfigApiController;
use App\Http\Controllers\ProjectApiController;
use App\Http\Controllers\HostApiController;
use App\Http\Controllers\McpRouteController;
use App\Http\Controllers\SkillApiController;
use App\Http\Controllers\CliAuthController;
use App\Http\Controllers\OpenAiApiController;
use App\Http\Controllers\ClaudeApiController;
use App\Http\Controllers\AdminOpenAiKeyController;
use App\Http\Controllers\AdminClaudeKeyController;
use App\Http\Controllers\AdminJoplinController;
use App\Http\Controllers\AdminManualController;
use App\Http\OpenAiResponse;
use App\Http\AnthropicResponse;
use App\Contracts\BackendAdapter;
use App\Adapters\RunnerBackendAdapter;
use App\Adapters\ClaudeBackendAdapter;
use App\Adapters\NullBackendAdapter;
use App\Repositories\OpenaiApiKeyRepository;
use App\Services\OpenaiApiKeyService;
use App\Repositories\CliAuthRequestRepository;
use App\Services\CliAuthService;
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
// Use a durable sentinel keyed to the schema source fingerprint so migration edits trigger a new migrate.
$schemaHash = DatabaseMigrator::schemaFingerprint($root);
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
// One-time backfill: pre-existing auth_payloads rows predate verification_state and should be treated as verified.
if ($runBackfillsOnBoot && $versionRepository->get('auth_payloads_verification_state_backfill_v1') === null) {
    try {
        $update = $database->connection()->prepare(
            "UPDATE auth_payloads SET verification_state = 'verified' WHERE verification_state = 'pending' OR verification_state IS NULL OR verification_state = ''"
        );
        $update->execute();
        $versionRepository->set('auth_payloads_verification_state_backfill_v1', gmdate(DATE_ATOM));
    } catch (\Throwable $exception) {
        error_log('[auth] verification_state backfill failed: ' . $exception->getMessage());
    }
}
$hostStateRepository = new HostAuthStateRepository($database);
$digestRepository = new HostAuthDigestRepository($database);
$hostUserRepository = new HostUserRepository($database);
$installTokenRepository = new InstallTokenRepository($database, $secretBox);
$seedTokenRepository = new AuthSeedTokenRepository($database, $secretBox);
$cliAuthRequestRepository = new CliAuthRequestRepository($database, $secretBox);
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
$dashboardGraphStatsRepository = new DashboardGraphStatsRepository($database);
// v2 wrapper: storage/seed paths are vestigial (kept in WrapperService signature
// for back-compat); the BinaryRegistry is the real source of truth.
$wrapperV2BinRootForService = (string) Config::get('WRAPPER_V2_BIN_ROOT', $root . '/storage/wrapper/v2/bin');
$wrapperService = new WrapperService(
    $versionRepository,
    '', '', $installationId, $secretBox, null, null,
    new BinaryRegistry($wrapperV2BinRootForService),
);
$dashboardGraphStatsService = new DashboardGraphStatsService(
    $dashboardGraphStatsRepository,
    $tokenUsageRepository,
    $chatGptUsageRepository,
    $versionRepository
);
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
$rateLimiter = new RateLimiter($ipRateLimitRepository);
$runnerValidationService = new RunnerValidationService(
    $hostRepository,
    $authPayloadRepository,
    $hostStateRepository,
    $logRepository,
    $versionRepository,
    $runnerVerifier
);
$service = new AuthService(
    $hostRepository,
    $authPayloadRepository,
    $hostStateRepository,
    $digestRepository,
    $hostUserRepository,
    $logRepository,
    $tokenUsageRepository,
    $tokenUsageIngestRepository,
    $versionRepository,
    $wrapperService,
    $insecureAuthRequestRepository,
    $runnerVerifier,
    $rateLimiter,
    $installationId,
    null,
    $insecureDomainAllowRepository,
    $mcpSessionTokenRepository,
    $mcpAccessLogRepository,
    $adminEventRepository,
    $dashboardGraphStatsService,
    $runnerValidationService
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
$cliAuthService = new CliAuthService($cliAuthRequestRepository, $service, $logRepository, $rateLimiter);
$projectModuleService = new ProjectModuleService($versionRepository);
$joplinSkillService = new JoplinSkillService($versionRepository);
$chatGptUsageService = new ChatGptUsageService(
    $service,
    $chatGptUsageRepository,
    $logRepository,
    (string) Config::get('CHATGPT_BASE_URL', 'https://chatgpt.com/backend-api'),
    (float) Config::get('CHATGPT_USAGE_TIMEOUT', 10.0),
    null,
    $dashboardGraphStatsService
);
$claudeUsageService = new ClaudeUsageService($versionRepository, $logRepository, $database);
$usageScalingService = new UsageScalingService($chatGptUsageService, $versionRepository);
$clientConfigService = new ClientConfigService($clientConfigRepository, $logRepository, $versionRepository, $mcpSessionTokenRepository, usageScalingService: $usageScalingService);
$skillManifestService = new SkillManifestService();
$skillSummaryService = new SkillSummaryService($authPayloadRepository, $logRepository, $runnerVerifier, $runnerValidationService);
$skillDraftService = new SkillDraftService($authPayloadRepository, $logRepository, $skillManifestService, $runnerVerifier, $runnerValidationService);
$skillService = new SkillService($skillRepository, $logRepository, $projectModuleService, $skillSummaryService, $skillManifestService, $joplinSkillService);
$memorySummaryService = new MemorySummaryService($authPayloadRepository, $logRepository, $runnerVerifier, $runnerValidationService);
$memoryService = new MemoryService($memoryRepository, $logRepository, $memorySummaryService);
$agentsService = new AgentsService($agentsRepository, $logRepository, $skillService, $clientConfigService, $memoryService, $versionRepository);
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
$projectDraftService = new ProjectDraftService(
    $authPayloadRepository,
    $logRepository,
    $projectCoordinationService,
    $runnerVerifier,
    $runnerValidationService
);
$joplinCacheService = null;
$joplinUrl = trim((string) ($versionRepository->get('joplin_url') ?? ''));
$joplinEmail = trim((string) ($versionRepository->get('joplin_email') ?? ''));
$joplinPassword = (string) ($versionRepository->get('joplin_password') ?? '');
if ($joplinUrl !== '' && $joplinEmail !== '' && $joplinPassword !== '') {
    $joplinNoteRepository = new JoplinNoteRepository($database);
    $joplinService = new JoplinService($joplinUrl, $joplinEmail, $joplinPassword);
    $joplinCacheService = new JoplinCacheService($joplinService, $joplinNoteRepository, $versionRepository);
}
$mcpServer = new McpServer($memoryService, $projectCoordinationService, $skillService, $root, $joplinCacheService);
$startupSyncService = new StartupSyncService($agentsService, $clientConfigService);
$agentsService->ensureSeededFromFile($root . '/AGENTS.md');
$wrapperService->ensureAllSeeded();
if ($runBackfillsOnBoot) {
    if ($versionRepository->get('supported_models_backfill_v1') === null) {
        try {
            $hostRepository->backfillUnsupportedModelOverrides();
            $clientConfigService->backfillUnsupportedModels();
            $versionRepository->set('supported_models_backfill_v1', gmdate(DATE_ATOM));
        } catch (\Throwable $exception) {
            error_log('[models] supported model backfill failed: ' . $exception->getMessage());
        }
    }
    $dashboardGraphStatsService->backfillMissingHistory();
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';
$normalizedPath = rtrim($path, '/');
if ($normalizedPath === '') {
    $normalizedPath = '/';
}

enforcePublicBaseUrlPolicy($normalizedPath);

// Preflight work (runner probe + GitHub release fetch) is owned by the preflight-cron service.
// Hot-path requests read cached state from MySQL only.

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
$apiDisableBypass = $normalizedPath === '/admin/api/state' || str_starts_with($normalizedPath, '/cli/auth/');
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

// --- isBrowserRequest helper ---

function isBrowserRequest(): bool {
    $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
    return stripos($accept, 'text/html') !== false;
}

// --- Controller instantiation ---

$cronCtrl = new CronController($service, $hostRepository, $versionRepository, $logRepository, $wrapperService);
$versionCtrl = new VersionController($service);
$adminPageCtrl = new AdminPageController(__DIR__);
$adminAuthCtrl = new AdminAuthController($adminAuthService, $adminPasskeyService, $adminUserRepository, $adminPasskeyRepository, $payload);
$adminUserCtrl = new AdminUserController($adminUserService, $adminUserRepository, $payload, __DIR__);
$adminSettingsCtrl = new AdminSettingsController($service, $versionRepository, $logRepository, $usageScalingService, $claudeUsageService);
$adminHostCtrl = new AdminHostController($hostRepository, $hostStateRepository, $authPayloadRepository, $digestRepository, $insecureAuthRequestRepository, $insecureDomainAllowRepository, $agentsRepository, $logRepository, $service, $installTokenRepository, $agentsService);
$adminOverviewCtrl = new AdminOverviewController($service, $hostRepository, $logRepository, $versionRepository, $authPayloadRepository, $seedTokenRepository, $tokenUsageRepository, $tokenUsageIngestRepository, $chatGptUsageService, $adminEventRepository, $digestRepository, $hostUserRepository, $insecureDomainAllowRepository, $usageScalingService, $claudeUsageService);
$adminConfigCtrl = new AdminConfigController($clientConfigService, $agentsService, $memoryService, $skillService, $skillDraftService, $mcpAccessLogRepository);
$adminProjectCtrl = new AdminProjectController($projectCoordinationService, $projectDraftService);
$adminJoplinCtrl = new AdminJoplinController($versionRepository, $logRepository, $joplinCacheService);
// v1 WrapperController / InstallController are gone — the legacy /wrapper, /install,
// /seed/auth routes are aliased to the v2 controllers below.
unset($wrapperCtrl, $installCtrl); // belt-and-braces in case of stale globals

// --- Wrapper bakery v2 wiring -------------------------------------------------
$wrapperV2Root = $root . '/storage/wrapper/v2';
$wrapperV2BinRoot = (string) Config::get('WRAPPER_V2_BIN_ROOT', $wrapperV2Root . '/bin');
$wrapperV2CacheRoot = (string) Config::get('WRAPPER_V2_CACHE_ROOT', $wrapperV2Root . '/cache');
$wrapperV2KeyPath = (string) Config::get('WRAPPER_V2_SIGNING_KEY', $wrapperV2Root . '/keys/signing.ed25519');
$wrapperV2BinaryRegistry = new BinaryRegistry($wrapperV2BinRoot);
$wrapperV2Cache = new BakeCache($wrapperV2CacheRoot);
$wrapperV2Ctrl = null;
$installV2Ctrl = null;
if (is_file($wrapperV2KeyPath)) {
    try {
        $wrapperV2Signer = new ConfigSigner($wrapperV2KeyPath);
        $wrapperV2Baker = new ConfigBaker(
            $hostRepository,
            $versionRepository,
            $wrapperV2Signer,
            $wrapperV2BinaryRegistry,
            $wrapperV2Cache,
            $database->connection(),
            $installationId,
        );
        $wrapperV2Ctrl = new WrapperV2Controller($service, $wrapperV2Baker, $wrapperV2Cache, $wrapperV2BinaryRegistry);
        $installV2Ctrl = new InstallV2Controller($installTokenRepository, $hostRepository, $logRepository, $service, $seedTokenRepository, $versionRepository);
    } catch (\Throwable $e) {
        error_log('[wrapper-v2] disabled: ' . $e->getMessage());
    }
} else {
    error_log('[wrapper-v2] signing key absent at ' . $wrapperV2KeyPath . ' — run scripts/wrapper-v2-init-keys.sh');
}
$cliAuthCtrl = new CliAuthController($cliAuthService, $adminAuthService, __DIR__);
$authCtrl = new AuthController($service, $chatGptUsageService, $startupSyncService, $versionRepository, $claudeUsageService);
$configApiCtrl = new ConfigApiController($service, $agentsService, $clientConfigService);
$projectApiCtrl = new ProjectApiController($service, $projectCoordinationService, $memoryService);
$skillApiCtrl = new SkillApiController($service, $skillService);
$hostApiCtrl = new HostApiController($service, $hostRepository, $logRepository, $versionRepository);
$mcpRouteCtrl = new McpRouteController($service, $mcpServer, $mcpAccessLogRepository);

// OpenAI-compatible API
$openaiKeyRepository = new OpenaiApiKeyRepository($database, $secretBox);
$openaiKeyService = new OpenaiApiKeyService($openaiKeyRepository, $logRepository);
$openaiModelService = new OpenAiModelService($clientConfigRepository, $versionRepository);
$openaiBackend = null;
if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
    $runnerExecUrl = preg_replace('#/verify$#', '/exec', $runnerUrl);
    $openaiBackend = new RunnerBackendAdapter(
        $runnerExecUrl,
        (string) Config::get('AUTH_RUNNER_SHARED_SECRET', ''),
        $service,
        $openaiModelService,
        (float) Config::get('OPENAI_API_TIMEOUT', 30.0)
    );
}
$openaiApiCtrl = new OpenAiApiController($openaiBackend, $openaiKeyService, $rateLimiter, $openaiModelService, $versionRepository);
$claudeModelService = new ClaudeModelService($clientConfigRepository, $versionRepository);
$claudeBackend = null;
if (is_string($runnerUrl) && trim($runnerUrl) !== '') {
    $claudeExecUrl = preg_replace('#/verify$#', '/exec', $runnerUrl);
    $claudeBackend = new ClaudeBackendAdapter(
        $claudeExecUrl,
        (string) Config::get('AUTH_RUNNER_SHARED_SECRET', ''),
        $service,
        $claudeModelService,
        (float) Config::get('OPENAI_API_TIMEOUT', 30.0)
    );
}
$claudeApiCtrl = new ClaudeApiController($claudeBackend, $openaiKeyService, $rateLimiter, $claudeModelService, $versionRepository);
$adminOpenAiKeyCtrl = new AdminOpenAiKeyController($openaiKeyService);
$adminClaudeKeyCtrl = new AdminClaudeKeyController($openaiKeyService);
$adminManualCtrl = new AdminManualController(__DIR__);

// --- Route wiring ---

// Cron endpoints
$router->add('POST', '#^/cron/check$#', fn() => $cronCtrl->check($payload));
$router->add('POST', '#^/cron/report$#', fn() => $cronCtrl->report($payload));

// Versions
$router->add('GET', '#^/versions$#', fn() => $versionCtrl->index());

// Admin pages (HTML)
$router->add('GET', '#^/admin/?$#', fn() => $adminPageCtrl->index());
$router->add('GET', '#^/admin/login$#', fn() => $adminPageCtrl->login());
$router->add('GET', '#^/admin/hosts/(\d+)$#', fn() => $adminPageCtrl->host());
$router->add('GET', '#^/admin/dashboard$#', fn() => $adminPageCtrl->dashboard());
$router->add('GET', '#^/admin/skills/new$#', fn() => $adminPageCtrl->skill());
$router->add('GET', '#^/admin/account(?:/(password|passkeys))?$#', fn() => $adminPageCtrl->account());
$router->add('GET', '#^/admin/settings$#', fn() => $adminPageCtrl->settings());
$router->add('GET', '#^/admin/settings/(general|users|agents|memories|projects|profiles|skills|config|claude|apikeys|joplin)$#', fn() => $adminPageCtrl->settingsSection());
$router->add('GET', '#^/admin/hosts/secure$#', fn() => $adminPageCtrl->hostsSecure());
$router->add('GET', '#^/admin/hosts/unprovisioned$#', fn() => $adminPageCtrl->hostsUnprovisioned());
$router->add('GET', '#^/admin/logs/(mcp|events)$#', fn() => $adminPageCtrl->logs());
$router->add('GET', '#^/admin/manual$#', fn() => $adminPageCtrl->manual());
$router->add('GET', '#^/admin/manual/manifest$#', fn() => $adminManualCtrl->manifest());
$router->add('GET', '#^/admin/manual/search$#', fn() => $adminManualCtrl->searchIndex());
$router->add('GET', '#^/admin/manual/article/([a-z0-9][a-z0-9-]{0,63})$#', function ($slug) use ($adminManualCtrl): void {
    if (is_string($slug)) { $adminManualCtrl->article($slug); }
});
$router->add('GET', '#^/admin/manual/[a-z0-9][a-z0-9-]{0,63}$#', fn() => $adminPageCtrl->manual());

// Admin settings
$router->add('POST', '#^/admin/versions/check$#', fn() => $adminSettingsCtrl->versionsCheck());

// Admin auth
$router->add('GET', '#^/admin/auth/status$#', fn() => $adminAuthCtrl->status());
$router->add('POST', '#^/admin/auth/login$#', fn() => $adminAuthCtrl->login());
$router->add('POST', '#^/admin/auth/login/method$#', fn() => $adminAuthCtrl->loginMethod());
$router->add('POST', '#^/admin/auth/logout$#', fn() => $adminAuthCtrl->logout());
$router->add('POST', '#^/admin/auth/password/change$#', fn() => $adminAuthCtrl->passwordChange());
$router->add('POST', '#^/admin/auth/password/request$#', fn() => $adminAuthCtrl->passwordRequest());
$router->add('POST', '#^/admin/auth/password/reset$#', fn() => $adminAuthCtrl->passwordReset());
$router->add('POST', '#^/admin/auth/passkey/login/options$#', fn() => $adminAuthCtrl->passkeyLoginOptions());
$router->add('POST', '#^/admin/auth/passkey/login$#', fn() => $adminAuthCtrl->passkeyLogin());
$router->add('POST', '#^/admin/auth/passkey/register/options$#', fn() => $adminAuthCtrl->passkeyRegisterOptions());
$router->add('POST', '#^/admin/auth/passkey/register$#', fn() => $adminAuthCtrl->passkeyRegister());
$router->add('GET', '#^/admin/passkeys$#', fn() => $adminAuthCtrl->passkeyList());
$router->add('POST', '#^/admin/passkeys/(\d+)/name$#', fn($id) => $adminAuthCtrl->passkeyRename($id));
$router->add('DELETE', '#^/admin/passkeys/(\d+)$#', fn($id) => $adminAuthCtrl->passkeyDelete($id));

// Admin users
$router->add('GET', '#^/admin/users$#', function () use ($adminUserCtrl, $adminPageCtrl): void {
    if (isBrowserRequest()) { $adminPageCtrl->settingsSection(); return; }
    $adminUserCtrl->index();
});
$router->add('POST', '#^/admin/users$#', fn() => $adminUserCtrl->store());
$router->add('POST', '#^/admin/users/(\d+)$#', fn($id) => $adminUserCtrl->update($id));
$router->add('DELETE', '#^/admin/users/(\d+)$#', fn($id) => $adminUserCtrl->delete($id));
$router->add('POST', '#^/admin/users/wipe$#', fn() => $adminUserCtrl->wipe());

// Wrapper — unversioned routes alias to v2 controllers (legacy code paths deleted).
$router->add('GET', '#^/wrapper$#', function () use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->meta();
});
$router->add('GET', '#^/wrapper/download$#', function () use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->download();
});

// Install / seed auth — unversioned routes alias to v2 controllers.
$router->add('GET', '#^/install/([a-f0-9\-]{36})$#', function (string $token) use (&$installV2Ctrl, $v2Unavailable): void {
    if ($installV2Ctrl === null) { $v2Unavailable(); return; }
    $installV2Ctrl->install($token);
});
$router->add('GET', '#^/seed/auth/([a-f0-9\-]{36})$#', function (string $token) use (&$installV2Ctrl, $v2Unavailable): void {
    if ($installV2Ctrl === null) { $v2Unavailable(); return; }
    $installV2Ctrl->seedAuthScript($token);
});
$router->add('POST', '#^/seed/auth/([a-f0-9\-]{36})$#', function (string $token) use (&$installV2Ctrl, $v2Unavailable): void {
    if ($installV2Ctrl === null) { $v2Unavailable(); return; }
    $installV2Ctrl->seedAuthStore($token);
});

// Wrapper bakery v2 — typed signed JSON + static binary delivery.
// These routes are wired unconditionally; if the signing key is absent the
// controller is null and we return 503 so operators see a clear failure mode.
$v2Available = static fn(): bool => isset($wrapperV2Ctrl) && $wrapperV2Ctrl instanceof WrapperV2Controller;
$v2Unavailable = static function () use (&$wrapperV2KeyPath): void {
    Response::json(['status' => 'error', 'message' => 'wrapper v2 not initialised (missing signing key at ' . $wrapperV2KeyPath . ')'], 503);
};
$router->add('GET', '#^/wrapper/v2/meta$#', function () use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->meta();
});
$router->add('GET', '#^/wrapper/v2/config$#', function () use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->config();
});
$router->add('GET', '#^/wrapper/v2/download$#', function () use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->download();
});
$router->add('GET', '#^/wrapper/v2/manifest/([a-z]+)$#', function (string $engine) use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->manifest($engine);
});
$router->add('GET', '#^/wrapper/v2/bin/([a-z]+)/([a-z0-9]+-[a-z0-9]+)/v([0-9A-Za-z.+\-_]+)/([a-z]+)$#', function (string $engine, string $platform, string $version, string $binary) use (&$wrapperV2Ctrl, $v2Available, $v2Unavailable): void {
    if (!$v2Available()) { $v2Unavailable(); return; }
    $wrapperV2Ctrl->binary($engine, $platform, $version, $binary);
});
$router->add('GET', '#^/install/v2/([a-f0-9\-]{36})$#', function (string $token) use (&$installV2Ctrl, $v2Unavailable): void {
    if ($installV2Ctrl === null) { $v2Unavailable(); return; }
    $installV2Ctrl->install($token);
});
$router->add('GET', '#^/seed/v2/auth/([a-f0-9\-]{36})$#', function (string $token) use (&$installV2Ctrl, $v2Unavailable): void {
    if ($installV2Ctrl === null) { $v2Unavailable(); return; }
    $installV2Ctrl->seedAuthScript($token);
});
$router->add('POST', '#^/seed/v2/auth/([a-f0-9\-]{36})$#', function (string $token) use (&$installV2Ctrl, $v2Unavailable): void {
    if ($installV2Ctrl === null) { $v2Unavailable(); return; }
    $installV2Ctrl->seedAuthStore($token);
});

// CLI auth (device-code login flow)
$router->add('POST', '#^/cli/auth/start$#', fn() => $cliAuthCtrl->start($payload));
$router->add('POST', '#^/cli/auth/poll/([a-f0-9]{64})$#', fn($id) => $cliAuthCtrl->poll($id));
$router->add('GET',  '#^/cli/auth/verify$#', fn() => $cliAuthCtrl->verifyPage());
$router->add('POST', '#^/cli/auth/lookup$#', fn() => $cliAuthCtrl->lookup($payload));
$router->add('POST', '#^/cli/auth/approve$#', fn() => $cliAuthCtrl->approve($payload));
$router->add('POST', '#^/cli/auth/deny$#', fn() => $cliAuthCtrl->deny($payload));

// Admin hosts
$router->add('POST', '#^/admin/hosts/register$#', function () use ($adminHostCtrl, $payload): void {
    $adminHostCtrl->register(is_array($payload) ? $payload : []);
});
$router->add('POST', '#^/admin/hosts/quick-register$#', function () use ($adminHostCtrl, $payload): void {
    $adminHostCtrl->quickRegister(is_array($payload) ? $payload : []);
});

// Admin runner
$router->add('GET', '#^/admin/runner$#', fn() => $adminOverviewCtrl->runner());
$router->add('POST', '#^/admin/runner/run$#', fn() => $adminOverviewCtrl->runnerRun());
$router->add('POST', '#^/admin/runner/run-claude$#', fn() => $adminOverviewCtrl->runnerRunClaude());
$router->add('POST', '#^/admin/auth/seed-command$#', fn() => $adminOverviewCtrl->seedCommand(is_array($payload) ? $payload : []));
$router->add('POST', '#^/admin/auth/upload$#', fn() => $adminOverviewCtrl->authUpload($payload));

// Admin settings (API state, CDX silent, reverse DNS, auto-update, etc.)
$router->add('GET', '#^/admin/api/state$#', fn() => $adminSettingsCtrl->getApiState());
$router->add('POST', '#^/admin/api/state$#', fn() => $adminSettingsCtrl->postApiState($payload));
$router->add('GET', '#^/admin/cdx-silent$#', fn() => $adminSettingsCtrl->getCdxSilent());
$router->add('POST', '#^/admin/cdx-silent$#', fn() => $adminSettingsCtrl->postCdxSilent($payload));
$router->add('GET', '#^/admin/theme$#', fn() => $adminSettingsCtrl->getTheme());
$router->add('POST', '#^/admin/theme$#', fn() => $adminSettingsCtrl->postTheme($payload));
$router->add('GET', '#^/admin/reverse-dns$#', fn() => $adminSettingsCtrl->getReverseDns());
$router->add('POST', '#^/admin/reverse-dns$#', fn() => $adminSettingsCtrl->postReverseDns($payload));
$router->add('GET', '#^/admin/auto-update$#', fn() => $adminSettingsCtrl->getAutoUpdate());
$router->add('POST', '#^/admin/auto-update$#', fn() => $adminSettingsCtrl->postAutoUpdate($payload));
$router->add('GET', '#^/admin/insecure-approval$#', fn() => $adminSettingsCtrl->getInsecureApproval());
$router->add('POST', '#^/admin/insecure-approval$#', fn() => $adminSettingsCtrl->postInsecureApproval($payload));
$router->add('POST', '#^/admin/codex-version$#', fn() => $adminSettingsCtrl->postCodexVersion($payload));
$router->add('GET', '#^/admin/quota-mode$#', fn() => $adminSettingsCtrl->getQuotaMode());
$router->add('POST', '#^/admin/quota-mode$#', fn() => $adminSettingsCtrl->postQuotaMode($payload));
$router->add('POST', '#^/admin/prune-policy$#', fn() => $adminSettingsCtrl->postPrunePolicy($payload));
$router->add('GET', '#^/admin/log-retention$#', fn() => $adminSettingsCtrl->getLogRetention());
$router->add('POST', '#^/admin/log-retention$#', fn() => $adminSettingsCtrl->postLogRetention($payload));
$router->add('GET', '#^/admin/scaling$#', fn() => $adminSettingsCtrl->getScaling());
$router->add('POST', '#^/admin/scaling$#', fn() => $adminSettingsCtrl->postScaling($payload));

// Admin: Claude version management & usage history
$router->add('GET', '#^/admin/claude/version$#', fn() => $adminSettingsCtrl->getClaudeVersion());
$router->add('POST', '#^/admin/claude/version$#', fn() => $adminSettingsCtrl->postClaudeVersion($payload));
$router->add('GET', '#^/admin/claude/usage/history$#', fn() => $adminSettingsCtrl->getClaudeUsageHistory());

// Admin host detail endpoints
$router->add('GET', '#^/admin/hosts/(\d+)/detail$#', fn($id) => $adminOverviewCtrl->hostDetail((int) $id));
$router->add('GET', '#^/admin/hosts/(\d+)/auth$#', fn($id) => $adminHostCtrl->auth($id));
$router->add('DELETE', '#^/admin/hosts/(\d+)$#', fn($id) => $adminHostCtrl->delete($id));
$router->add('POST', '#^/admin/hosts/(\d+)/clear$#', fn($id) => $adminHostCtrl->clear($id));
$router->add('POST', '#^/admin/hosts/(\d+)/roaming$#', fn($id) => $adminHostCtrl->roaming($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/secure$#', fn($id) => $adminHostCtrl->secure($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/vip$#', fn($id) => $adminHostCtrl->vip($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/scaling-exempt$#', fn($id) => $adminHostCtrl->scalingExempt($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/auto-update$#', fn($id) => $adminHostCtrl->autoUpdate($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/insecure/enable$#', fn($id) => $adminHostCtrl->insecureEnable($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/insecure/disable$#', fn($id) => $adminHostCtrl->insecureDisable($id));
$router->add('GET', '#^/admin/insecure-approvals/pending$#', fn() => $adminHostCtrl->insecureApprovalPending());
$router->add('POST', '#^/admin/insecure-approvals/(\d+)/allow-domain$#', fn($id) => $adminHostCtrl->insecureApprovalAllowDomain($id, $payload));
$router->add('POST', '#^/admin/insecure-approvals/(\d+)/approve$#', fn($id) => $adminHostCtrl->insecureApprovalApprove($id, $payload));
$router->add('POST', '#^/admin/insecure-approvals/(\d+)/deny$#', fn($id) => $adminHostCtrl->insecureApprovalDeny($id));
$router->add('POST', '#^/admin/insecure-domain-allows/(\d+)/revoke$#', fn($id) => $adminHostCtrl->insecureDomainRevoke($id));
$router->add('POST', '#^/admin/hosts/(\d+)/curl-insecure$#', fn($id) => $adminHostCtrl->curlInsecure($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/reverse-dns$#', fn($id) => $adminHostCtrl->reverseDns($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/model$#', fn($id) => $adminHostCtrl->model($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/codex-version$#', fn($id) => $adminHostCtrl->codexVersion($id, $payload));
$router->add('POST', '#^/admin/hosts/(\d+)/claude-version$#', fn(string $id) => $adminHostCtrl->claudeVersion($id, is_array($payload) ? $payload : []));
$router->add('POST', '#^/admin/hosts/(\d+)/agents-version$#', fn($id) => $adminHostCtrl->agentsVersion($id, $payload));

// Admin overview
$router->add('GET', '#^/admin/overview$#', fn() => $adminOverviewCtrl->overview());
$router->add('GET', '#^/admin/ws/info$#', fn() => $adminOverviewCtrl->wsInfo());
$router->add('POST', '#^/admin/toasts$#', fn() => $adminOverviewCtrl->toasts($payload));

// Admin hosts (browser/API split)
$router->add('GET', '#^/admin/hosts$#', function () use ($adminOverviewCtrl): void {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    $adminOverviewCtrl->hosts();
});
$router->add('GET', '#^/admin/hosts/insecure$#', function () use ($adminOverviewCtrl): void {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    $adminOverviewCtrl->hostsInsecure();
});
$router->add('POST', '#^/admin/hosts/insecure/extend$#', fn() => $adminOverviewCtrl->hostsInsecureExtend());
$router->add('POST', '#^/admin/hosts/insecure/disable-all$#', fn() => $adminOverviewCtrl->hostsInsecureDisableAll());

// Admin logs (browser/API split)
$router->add('GET', '#^/admin/logs$#', function () use ($adminOverviewCtrl): void {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    $adminOverviewCtrl->logs();
});

// Admin usage
$router->add('GET', '#^/admin/usage/ingests$#', fn() => $adminOverviewCtrl->usageIngests());
$router->add('GET', '#^/admin/usage$#', fn() => $adminOverviewCtrl->usage());
$router->add('GET', '#^/admin/chatgpt/usage$#', fn() => $adminOverviewCtrl->chatgptUsage());
$router->add('GET', '#^/admin/chatgpt/usage/history$#', fn() => $adminOverviewCtrl->chatgptUsageHistory());
$router->add('POST', '#^/admin/chatgpt/usage/refresh$#', fn() => $adminOverviewCtrl->chatgptUsageRefresh());

// Admin tokens
$router->add('GET', '#^/admin/tokens$#', fn() => $adminOverviewCtrl->tokens());

// Admin config
$router->add('GET', '#^/admin/config$#', fn() => $adminConfigCtrl->config());
$router->add('GET', '#^/admin/mcp/logs$#', fn() => $adminConfigCtrl->mcpLogs());
$router->add('POST', '#^/admin/config/render$#', fn() => $adminConfigCtrl->configRender($payload));
$router->add('POST', '#^/admin/config/store$#', fn() => $adminConfigCtrl->configStore($payload));

// Admin agents
$router->add('GET', '#^/admin/agents$#', fn() => $adminConfigCtrl->agents());
$router->add('GET', '#^/admin/agents/versions/(\d+)$#', fn($id) => $adminConfigCtrl->agentsVersion((int) $id));
$router->add('POST', '#^/admin/agents/store$#', fn() => $adminConfigCtrl->agentsStore($payload));
$router->add('POST', '#^/admin/agents/serve$#', fn() => $adminConfigCtrl->agentsServe($payload));
$router->add('POST', '#^/admin/agents/revert$#', fn() => $adminConfigCtrl->agentsRevert($payload));
$router->add('POST', '#^/admin/agents/retention$#', fn() => $adminConfigCtrl->agentsRetention($payload));
$router->add('DELETE', '#^/admin/agents/versions/(\d+)$#', fn($id) => $adminConfigCtrl->agentsDeleteVersion($id));

// Admin memories
$router->add('GET', '#^/admin/mcp/memories$#', fn() => $adminConfigCtrl->memories());
$router->add('DELETE', '#^/admin/mcp/memories/(\d+)$#', fn($id) => $adminConfigCtrl->memoriesDelete($id));

// Admin skills
$router->add('GET', '#^/admin/skills$#', fn() => $adminConfigCtrl->skills());
$router->add('GET', '#^/admin/skills/([^/]+)$#', function ($slug) use ($adminConfigCtrl, $adminPageCtrl): void {
    if (isBrowserRequest()) { $adminPageCtrl->skill(); return; }
    $adminConfigCtrl->skillShow($slug);
});
$router->add('POST', '#^/admin/skills/generate$#', fn() => $adminConfigCtrl->skillGenerate($payload));
$router->add('POST', '#^/admin/skills/assist$#', fn() => $adminConfigCtrl->skillAssist($payload));
$router->add('POST', '#^/admin/skills/store$#', fn() => $adminConfigCtrl->skillStore($payload));
$router->add('DELETE', '#^/admin/skills/([^/]+)$#', fn($slug) => $adminConfigCtrl->skillDelete($slug));

// Admin projects
$router->add('GET', '#^/admin/projects/state$#', fn() => $adminProjectCtrl->state());
$router->add('POST', '#^/admin/projects/state$#', fn() => $adminProjectCtrl->stateUpdate($payload));
$router->add('GET', '#^/admin/projects/feedback$#', fn() => $adminProjectCtrl->allFeedback());
$router->add('GET', '#^/admin/projects$#', fn() => $adminProjectCtrl->index());
$router->add('POST', '#^/admin/projects$#', fn() => $adminProjectCtrl->create($payload));
$router->add('DELETE', '#^/admin/projects/([^/]+)$#', fn($slug) => $adminProjectCtrl->delete($slug));
$router->add('GET', '#^/admin/projects/([^/]+)$#', function ($slug) use ($adminProjectCtrl): void {
    if (isBrowserRequest()) { require __DIR__ . '/admin/index.php'; return; }
    $adminProjectCtrl->show($slug);
});
$router->add('POST', '#^/admin/projects/([^/]+)/assist$#', fn($slug) => $adminProjectCtrl->assist($slug));
$router->add('POST', '#^/admin/projects/([^/]+)/about$#', fn($slug) => $adminProjectCtrl->updateAbout($slug, $payload));
$router->add('POST', '#^/admin/projects/([^/]+)/roster$#', fn($slug) => $adminProjectCtrl->updateRoster($slug, $payload));
$router->add('GET', '#^/admin/projects/([^/]+)/changes$#', fn($slug) => $adminProjectCtrl->changes($slug));
$router->add('GET', '#^/admin/projects/([^/]+)/notes$#', fn($slug) => $adminProjectCtrl->notes($slug));
$router->add('POST', '#^/admin/projects/([^/]+)/notes$#', fn($slug) => $adminProjectCtrl->noteCreate($slug, $payload));
$router->add('POST', '#^/admin/projects/([^/]+)/notes/(\d+)$#', fn($slug, $id) => $adminProjectCtrl->noteUpdate($slug, $id, $payload));
$router->add('DELETE', '#^/admin/projects/([^/]+)/notes/(\d+)$#', fn($slug, $id) => $adminProjectCtrl->noteDelete($slug, $id));
$router->add('GET', '#^/admin/projects/([^/]+)/todos$#', fn($slug) => $adminProjectCtrl->todos($slug));
$router->add('POST', '#^/admin/projects/([^/]+)/todos$#', fn($slug) => $adminProjectCtrl->todoCreate($slug, $payload));
$router->add('POST', '#^/admin/projects/([^/]+)/todos/(\d+)$#', fn($slug, $id) => $adminProjectCtrl->todoUpdate($slug, $id, $payload));
$router->add('POST', '#^/admin/projects/([^/]+)/todos/(\d+)/done$#', fn($slug, $id) => $adminProjectCtrl->todoDone($slug, $id));
$router->add('POST', '#^/admin/projects/([^/]+)/todos/(\d+)/undone$#', fn($slug, $id) => $adminProjectCtrl->todoUndone($slug, $id));
$router->add('DELETE', '#^/admin/projects/([^/]+)/todos/(\d+)$#', fn($slug, $id) => $adminProjectCtrl->todoDelete($slug, $id));
$router->add('GET', '#^/admin/projects/([^/]+)/files$#', fn($slug) => $adminProjectCtrl->files($slug));
$router->add('POST', '#^/admin/projects/([^/]+)/files$#', fn($slug) => $adminProjectCtrl->fileCreate($slug, $payload));
$router->add('DELETE', '#^/admin/projects/([^/]+)/files/(\d+)$#', fn($slug, $id) => $adminProjectCtrl->fileDelete($slug, $id));
$router->add('GET', '#^/admin/projects/([^/]+)/feedback$#', fn($slug) => $adminProjectCtrl->feedback($slug));
$router->add('POST', '#^/admin/projects/([^/]+)/feedback$#', fn($slug) => $adminProjectCtrl->feedbackCreate($slug, $payload));

// Admin Joplin
$router->add('GET', '#^/admin/joplin/config$#', fn() => $adminJoplinCtrl->getConfig());
$router->add('POST', '#^/admin/joplin/config$#', fn() => $adminJoplinCtrl->postConfig($payload));
$router->add('POST', '#^/admin/joplin/test$#', fn() => $adminJoplinCtrl->postTest($payload));
$router->add('POST', '#^/admin/joplin/sync$#', fn() => $adminJoplinCtrl->postSync());

// Client-facing auth
$router->add('POST', '#^/auth$#', fn() => $authCtrl->auth($payload));
$router->add('POST', '#^/sync/status$#', fn() => $authCtrl->syncStatus($payload));
$router->add('POST', '#^/sync/bootstrap$#', fn() => $authCtrl->syncBootstrap($payload));
$router->add('DELETE', '#^/auth$#', fn() => $authCtrl->deleteAuth());

// Config API
$router->add('POST', '#^/agents/retrieve$#', fn() => $configApiCtrl->agentsRetrieve($payload));
$router->add('POST', '#^/config/retrieve$#', fn() => $configApiCtrl->configRetrieve($payload));

// Project API
$router->add('GET', '#^/projects$#', fn() => $projectApiCtrl->index());
$router->add('POST', '#^/projects$#', fn() => $projectApiCtrl->create($payload));
$router->add('GET', '#^/projects/([^/]+)/bootstrap$#', fn($slug) => $projectApiCtrl->bootstrap($slug));
$router->add('GET', '#^/projects/([^/]+)$#', fn($slug) => $projectApiCtrl->detail($slug));
$router->add('POST', '#^/projects/([^/]+)/about$#', fn($slug) => $projectApiCtrl->updateAbout($slug, $payload));
$router->add('POST', '#^/projects/([^/]+)/roster$#', fn($slug) => $projectApiCtrl->updateRoster($slug, $payload));
$router->add('GET', '#^/projects/([^/]+)/changes$#', fn($slug) => $projectApiCtrl->listChanges($slug));
$router->add('GET', '#^/projects/([^/]+)/notes$#', fn($slug) => $projectApiCtrl->listNotes($slug));
$router->add('POST', '#^/projects/([^/]+)/notes$#', fn($slug) => $projectApiCtrl->createNote($slug, $payload));
$router->add('POST', '#^/projects/([^/]+)/notes/(\d+)$#', fn($slug, $id) => $projectApiCtrl->updateNote($slug, $id, $payload));
$router->add('DELETE', '#^/projects/([^/]+)/notes/(\d+)$#', fn($slug, $id) => $projectApiCtrl->deleteNote($slug, $id));
$router->add('GET', '#^/projects/([^/]+)/todos$#', fn($slug) => $projectApiCtrl->listTodos($slug));
$router->add('POST', '#^/projects/([^/]+)/todos$#', fn($slug) => $projectApiCtrl->createTodo($slug, $payload));
$router->add('POST', '#^/projects/([^/]+)/todos/(\d+)$#', fn($slug, $id) => $projectApiCtrl->updateTodo($slug, $id, $payload));
$router->add('POST', '#^/projects/([^/]+)/todos/(\d+)/done$#', fn($slug, $id) => $projectApiCtrl->setTodoDone($slug, $id));
$router->add('POST', '#^/projects/([^/]+)/todos/(\d+)/undone$#', fn($slug, $id) => $projectApiCtrl->setTodoUndone($slug, $id));
$router->add('DELETE', '#^/projects/([^/]+)/todos/(\d+)$#', fn($slug, $id) => $projectApiCtrl->deleteTodo($slug, $id));
$router->add('GET', '#^/projects/([^/]+)/files$#', fn($slug) => $projectApiCtrl->listFiles($slug));
$router->add('POST', '#^/projects/([^/]+)/files$#', fn($slug) => $projectApiCtrl->upsertFile($slug, $payload));
$router->add('DELETE', '#^/projects/([^/]+)/files/(\d+)$#', fn($slug, $id) => $projectApiCtrl->deleteFile($slug, $id));
$router->add('GET', '#^/projects/([^/]+)/feedback$#', fn($slug) => $projectApiCtrl->listFeedback($slug));
$router->add('POST', '#^/projects/([^/]+)/feedback$#', fn($slug) => $projectApiCtrl->createFeedback($slug, $payload));

// MCP memories API
$router->add('POST', '#^/mcp/memories/store$#', fn() => $projectApiCtrl->memoriesStore($payload));
$router->add('POST', '#^/mcp/memories/delete$#', fn() => $projectApiCtrl->memoriesDelete($payload));
$router->add('DELETE', '#^/mcp/memories/([^/]+)$#', fn($id) => $projectApiCtrl->memoriesDeleteById($id));
$router->add('POST', '#^/mcp/memories/retrieve$#', fn() => $projectApiCtrl->memoriesRetrieve($payload));
$router->add('POST', '#^/mcp/memories/search$#', fn() => $projectApiCtrl->memoriesSearch($payload));

// Skills API
$router->add('GET', '#^/skills$#', fn() => $skillApiCtrl->listSkills());
$router->add('POST', '#^/skills/retrieve$#', fn() => $skillApiCtrl->retrieveSkill($payload));
$router->add('POST', '#^/skills/store$#', fn() => $skillApiCtrl->storeSkill($payload));

// Host API
$router->add('POST', '#^/host/users$#', fn() => $hostApiCtrl->recordUsers($payload));
$router->add('GET', '#^/host/lane$#', fn() => $hostApiCtrl->getLane());
$router->add('POST', '#^/host/lane$#', fn() => $hostApiCtrl->setLane($payload));
$router->add('POST', '#^/usage$#', fn() => $hostApiCtrl->recordUsage($payload));

// MCP endpoint
$router->add('GET', '#^/mcp$#', fn() => $mcpRouteCtrl->probe());
$router->add('POST', '#^/mcp$#', fn() => $mcpRouteCtrl->handle($rawBody));

// OpenAI-compatible API
$router->add('OPTIONS', '#^/v1/#', fn() => $openaiApiCtrl->options());
$router->add('POST', '#^/v1/chat/completions$#', fn() => $openaiApiCtrl->chatCompletions($payload));
$router->add('POST', '#^/v1/responses$#', fn() => $openaiApiCtrl->responses($payload));
$router->add('POST', '#^/v1/completions$#', fn() => $openaiApiCtrl->completions($payload));
$router->add('POST', '#^/v1/embeddings$#', fn() => $openaiApiCtrl->embeddings($payload));
$router->add('GET', '#^/v1/models$#', fn() => $openaiApiCtrl->models());

// Anthropic-compatible API
$router->add('OPTIONS', '#^/anthropic/v1/#', fn() => $claudeApiCtrl->options());
$router->add('POST', '#^/anthropic/v1/messages$#', fn() => $claudeApiCtrl->messages($payload));
$router->add('POST', '#^/anthropic/v1/completions$#', fn() => $claudeApiCtrl->completions($payload));
$router->add('GET', '#^/anthropic/v1/models$#', fn() => $claudeApiCtrl->models());
$router->add('POST', '#^/anthropic/v1/responses$#', fn() => $claudeApiCtrl->responses($payload));
$router->add('POST', '#^/anthropic/v1/embeddings$#', fn() => $claudeApiCtrl->embeddings($payload));

// Admin: OpenAI API key management
$router->add('GET', '#^/admin/openai/keys$#', fn() => $adminOpenAiKeyCtrl->index());
$router->add('POST', '#^/admin/openai/keys$#', fn() => $adminOpenAiKeyCtrl->store($payload));
$router->add('POST', '#^/admin/openai/keys/(\d+)/toggle$#', fn($id) => $adminOpenAiKeyCtrl->toggle($id, $payload));
$router->add('DELETE', '#^/admin/openai/keys/(\d+)$#', fn($id) => $adminOpenAiKeyCtrl->delete($id));
$router->add('GET', '#^/admin/openai/state$#', fn() => $adminSettingsCtrl->getOpenaiApiState());
$router->add('POST', '#^/admin/openai/state$#', fn() => $adminSettingsCtrl->postOpenaiApiState($payload));

// Admin: Claude API key management & settings
$router->add('GET', '#^/admin/claude/keys$#', fn() => $adminClaudeKeyCtrl->index());
$router->add('POST', '#^/admin/claude/keys$#', fn() => $adminClaudeKeyCtrl->store($payload));
$router->add('POST', '#^/admin/claude/keys/(\d+)/toggle$#', fn($id) => $adminClaudeKeyCtrl->toggle($id, $payload));
$router->add('DELETE', '#^/admin/claude/keys/(\d+)$#', fn($id) => $adminClaudeKeyCtrl->delete($id));
$router->add('GET', '#^/admin/claude/state$#', fn() => $adminSettingsCtrl->getClaudeApiState());
$router->add('POST', '#^/admin/claude/state$#', fn() => $adminSettingsCtrl->postClaudeApiState($payload));
$router->add('GET', '#^/admin/claude/settings$#', fn() => $adminSettingsCtrl->getClaudeSettings());
$router->add('POST', '#^/admin/claude/settings$#', fn() => $adminSettingsCtrl->postClaudeSettings($payload));

// --- Dispatch + error handling ---

if (str_starts_with($normalizedPath, '/anthropic/v1/')) {
    // Anthropic-compatible error envelopes for /anthropic/v1/ routes
    if ($versionRepository->getFlag('claude_api_disabled', false) && $method !== 'OPTIONS') {
        AnthropicResponse::error('Claude API disabled by administrator', 'api_error', 503);
    }
    try {
        $handled = $router->dispatch($method, $normalizedPath);
        if (!$handled) {
            AnthropicResponse::error('Unknown endpoint', 'not_found_error', 404);
        }
    } catch (HttpException $exception) {
        AnthropicResponse::error($exception->getMessage(), 'api_error', $exception->getStatusCode());
    } catch (Throwable $exception) {
        error_log('Anthropic API error: ' . $exception->getMessage());
        error_log($exception->getTraceAsString());
        AnthropicResponse::error('Internal server error', 'api_error', 500);
    }
} elseif (str_starts_with($normalizedPath, '/v1/') || $normalizedPath === '/v1') {
    // OpenAI-compatible error envelopes for /v1/ routes
    $openaiApiDisabled = $versionRepository->getFlag('openai_api_disabled', false);
    if ($openaiApiDisabled && $method !== 'OPTIONS') {
        OpenAiResponse::error('OpenAI API disabled by administrator', 'api_error', 503, 'api_disabled');
    }
    try {
        $handled = $router->dispatch($method, $normalizedPath);
        if (!$handled) {
            OpenAiResponse::error('Unknown endpoint', 'invalid_request_error', 404);
        }
    } catch (HttpException $exception) {
        OpenAiResponse::error($exception->getMessage(), 'api_error', $exception->getStatusCode());
    } catch (Throwable $exception) {
        error_log('OpenAI API error: ' . $exception->getMessage());
        error_log($exception->getTraceAsString());
        OpenAiResponse::error('An internal server error occurred.', 'internal_server_error', 500);
    }
} else {
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
}
