<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Config;
use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Http\Response;
use App\Repositories\AdminEventRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\AuthSeedTokenRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\InsecureDomainAllowRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\AdminAuthService;
use App\Services\AuthService;
use App\Services\ChatGptUsageService;
use App\Services\CostHistoryService;
use App\Services\PricingService;
use App\Services\UsageScalingService;
use App\Support\AdminTheme;
use App\Support\CodexVersionPolicy;
use DateTimeImmutable;

class AdminOverviewController
{
    public function __construct(
        private AuthService $service,
        private HostRepository $hostRepository,
        private LogRepository $logRepository,
        private VersionRepository $versionRepository,
        private AuthPayloadRepository $authPayloadRepository,
        private AuthSeedTokenRepository $seedTokenRepository,
        private TokenUsageRepository $tokenUsageRepository,
        private TokenUsageIngestRepository $tokenUsageIngestRepository,
        private ChatGptUsageService $chatGptUsageService,
        private PricingService $pricingService,
        private CostHistoryService $costHistoryService,
        private AdminEventRepository $adminEventRepository,
        private HostAuthDigestRepository $digestRepository,
        private HostUserRepository $hostUserRepository,
        private InsecureDomainAllowRepository $insecureDomainAllowRepository,
        private ?UsageScalingService $usageScalingService = null,
        private string $pricingModel = 'gpt-5.4',
    ) {}

    /**
     * GET /admin/runner
     */
    public function runner(): void
    {
        requireAdminAccess();

        $runnerUrl = (string) Config::get('AUTH_RUNNER_URL', '');
        $enabled = trim($runnerUrl) !== '';
        $defaultBaseUrl = (string) Config::get('AUTH_RUNNER_CODEX_BASE_URL', 'http://api');
        $timeoutSeconds = (float) Config::get('AUTH_RUNNER_TIMEOUT', 8.0);

        $since = gmdate(DATE_ATOM, time() - 86400);
        $latestValidationRow = $this->logRepository->recentByActions(['auth.validate'], 1);
        $latestRunnerStoreRow = $this->logRepository->recentByActions(['auth.runner_store'], 1);

        $hostRepository = $this->hostRepository;

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
        $canonicalPayloadId = $this->versionRepository->get('canonical_payload_id');
        if ($canonicalPayloadId !== null && ctype_digit((string) $canonicalPayloadId)) {
            $canonicalPayload = $this->authPayloadRepository->findMetadataById((int) $canonicalPayloadId);
        }
        if ($canonicalPayload === null) {
            $canonicalPayload = $this->authPayloadRepository->latestMetadata();
        }

        $canonicalSourceHostId = null;
        $canonicalSourceHost = null;
        if ($canonicalPayload !== null) {
            $raw = $canonicalPayload['source_host_id'] ?? null;
            if ($raw !== null && is_numeric($raw)) {
                $canonicalSourceHostId = (int) $raw;
            }
            if ($canonicalSourceHostId !== null && $canonicalSourceHostId > 0) {
                $canonicalSourceHost = $formatHostBrief($this->hostRepository->findById($canonicalSourceHostId));
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
                'last_daily_check' => $this->versionRepository->get('runner_last_check'),
                'last_failure' => $this->versionRepository->get('runner_last_fail'),
                'last_ok' => $this->versionRepository->get('runner_last_ok'),
                'state' => $this->versionRepository->get('runner_state'),
                'boot_id' => $this->versionRepository->get('runner_boot_id'),
                'base_url' => Config::get('AUTH_RUNNER_CODEX_BASE_URL', $defaultBaseUrl),
                'timeout_seconds' => $timeoutSeconds,
                'counts' => [
                    'validations_24h' => $this->logRepository->countActionsSince(['auth.validate'], $since),
                    'runner_store_24h' => $this->logRepository->countActionsSince(['auth.runner_store'], $since),
                ],
                'latest_validation' => $formatLog($latestValidationRow[0] ?? null),
                'latest_runner_store' => $formatLog($latestRunnerStoreRow[0] ?? null),
                'canonical_auth' => $canonicalAuth,
            ],
        ]);
    }

    /**
     * POST /admin/runner/run
     */
    public function runnerRun(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        try {
            $result = $this->service->triggerRunnerRefresh();
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
    }

    /**
     * POST /admin/auth/seed-command
     */
    public function seedCommand(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $this->seedTokenRepository->deleteExpired(gmdate(DATE_ATOM));

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

        $tokenRow = $this->seedTokenRepository->create(generateUuid(), $expiresAt, $baseUrl);
        $command = seedAuthCommand($baseUrl, (string) $tokenRow['token']);

        $this->logRepository->log(null, 'admin.seed_token.create', [
            'expires_at' => $expiresAt,
            'token' => substr((string) $tokenRow['token'], 0, 8) . "\u{2026}",
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'command' => $command,
                'expires_at' => $expiresAt,
            ],
        ]);
    }

    /**
     * POST /admin/auth/upload
     */
    public function authUpload(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $hostIdRaw = $payload['host_id'] ?? null;
        $systemUpload = $hostIdRaw === null || $hostIdRaw === '' || $hostIdRaw === 'system' || (is_numeric($hostIdRaw) && (int) $hostIdRaw === 0);
        $host = null;
        if (!$systemUpload) {
            $hostId = (int) $hostIdRaw;
            $host = $this->hostRepository->findById($hostId);
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
            $result = $this->service->handleAuth(
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
    }

    /**
     * GET /admin/overview
     */
    public function overview(): void
    {
        requireAdminAccess();
        $this->service->pruneStaleHosts();

        $hosts = $this->hostRepository->all();
        $countHosts = count($hosts);
        $latestLog = $this->logRepository->recent(1);
        $versions = $this->service->versionSummary();
        $lastRefresh = null;
        $avgRefreshDays = null;
        $hasCanonicalAuth = $this->service->hasCanonicalAuth();
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

        $tokens = $this->tokenUsageRepository->totals();
        $tokens['top_host'] = $this->tokenUsageRepository->topHost();
        $chatgpt = $this->chatGptUsageService->fetchLatest(false);
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
        $tokensDay = $this->tokenUsageRepository->totalsForRange($dayStart, $dayEnd);
        $tokensMonth = $this->tokenUsageRepository->totalsForRange($monthStart, $monthEnd);
        $tokensWeek = $this->tokenUsageRepository->totalsForRange($weekStart, $weekEnd);
        $pricing = $this->pricingService->latestPricing($this->pricingModel, false);
        $dailyCost = $this->pricingService->calculateCost($pricing, $tokensDay);
        $monthlyCost = $this->pricingService->calculateCost($pricing, $tokensMonth);
        $weeklyCost = $this->pricingService->calculateCost($pricing, $tokensWeek);
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
        $quotaHardFail = $this->versionRepository->getFlag('quota_hard_fail', true);
        $quotaLimitPercent = quotaLimitPercent($this->versionRepository);
        $quotaWeekPartition = quotaWeekPartition($this->versionRepository);
        $cdxSilent = $this->versionRepository->getFlag('cdx_silent', false);
        $adminTheme = AdminTheme::normalize($this->versionRepository->get('admin_theme'));
        $reverseDnsEnabled = $this->versionRepository->getFlag('reverse_dns_enabled', false);
        $insecureApprovalEnabled = $this->versionRepository->getFlag('insecure_approval_enabled', false);
        $autoUpdateEnabled = $this->versionRepository->getFlag('auto_update_enabled', false);
        $inactivityWindowDays = inactivityWindowDays($this->versionRepository);
        $logRetentionEnabled = $this->versionRepository->getFlag('log_retention_enabled', false);
        $logRetentionDaysLogs = $this->logRetentionDays('log_retention_days_logs', 90);
        $logRetentionDaysMcp = $this->logRetentionDays('log_retention_days_mcp', 90);
        $logRetentionDaysEvents = $this->logRetentionDays('log_retention_days_events', 30);
        $logRetentionDaysGraphStats = $this->logRetentionDays('log_retention_days_graph_stats', 180);
        $clientVersionLock = $this->versionRepository->getWithMetadata('client_version_lock');
        $chatgptSummary = $this->chatGptUsageService->latestWindowSummary();
        if (is_array($chatgptSummary)) {
            $globalLaneSpark = modelUsesSparkQuotaLane($this->versionRepository->get('cdx_model'));
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
                'admin_theme' => $adminTheme,
                'reverse_dns_enabled' => $reverseDnsEnabled,
                'insecure_approval_enabled' => $insecureApprovalEnabled,
                'auto_update_enabled' => $autoUpdateEnabled,
                'inactivity_window_days' => $inactivityWindowDays,
                'log_retention_enabled' => $logRetentionEnabled,
                'log_retention_days_logs' => $logRetentionDaysLogs,
                'log_retention_days_mcp' => $logRetentionDaysMcp,
                'log_retention_days_events' => $logRetentionDaysEvents,
                'log_retention_days_graph_stats' => $logRetentionDaysGraphStats,
                'client_version_lock' => $clientVersionLock['version'] ?? null,
                'client_version_lock_updated_at' => $clientVersionLock['updated_at'] ?? null,
                'scaling' => $this->usageScalingService?->currentStatus(),
            ],
        ]);
    }

    /**
     * GET /admin/ws/info
     */
    public function wsInfo(): void
    {
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
                'last_event_id' => $enabled ? $this->adminEventRepository->latestId() : 0,
                'heartbeat_seconds' => $heartbeat,
                'backlog_limit' => $backlog,
            ],
        ]);
    }

    /**
     * POST /admin/toasts
     */
    public function toasts(array $payload): void
    {
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

        $event = $this->adminEventRepository->append('toast', $toastPayload, null);
        $this->logRepository->log(null, 'admin.toast', [
            'level' => $level,
            'title' => $title,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'event' => $event,
            ],
        ]);
    }

    /**
     * GET /admin/hosts
     */
    public function hosts(): void
    {
        requireAdminAccess();
        $this->service->pruneStaleHosts();

        $canonicalDigest = null;
        $canonicalSourceHostId = null;
        $canonicalPayloadId = $this->versionRepository->get('canonical_payload_id');
        if ($canonicalPayloadId !== null && ctype_digit((string) $canonicalPayloadId)) {
            $canonicalPayload = $this->authPayloadRepository->findByIdWithEntries((int) $canonicalPayloadId);
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

        $hosts = $this->hostRepository->all();
        $hostIds = array_map(
            static fn (array $host): int => isset($host['id']) ? (int) $host['id'] : 0,
            $hosts
        );
        $cronEvents = $this->logRepository->latestByHostAndActions($hostIds, [
            'cron.update_available',
            'cron.update_reported',
        ]);
        $versionSummary = $this->service->versionSummary();
        $globalAutoUpdateEnabled = (bool) ($versionSummary['auto_update_enabled'] ?? false);
        $digests = $this->digestRepository->byHostId();

        $hostIds = array_map(static fn(array $h): int => (int) $h['id'], $hosts);
        $tokenUsageMap = $this->tokenUsageRepository->latestForHosts($hostIds);
        $usersMap      = $this->hostUserRepository->listByHosts($hostIds);

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
        foreach ($hosts as $host) {
            $hostVersions = $this->service->applyClientVersionOverrideForHost($versionSummary, $host);
            $hostCronEvents = $cronEvents[(int) ($host['id'] ?? 0)] ?? [];
            $autoUpdateState = $this->deriveAutoUpdateState($host, $hostVersions, $globalAutoUpdateEnabled, $hostCronEvents);
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
                'curl_insecure' => isset($host['curl_insecure']) ? (bool) (int) $host['curl_insecure'] : false,
                'last_cron_check' => $normalizeTs($host['last_cron_check'] ?? null),
                'reverse_dns_mode' => formatReverseDnsModeOutput($host['reverse_dns_mode'] ?? null),
                'lane_preference' => AuthService::normalizeQuotaLane($host['lane_preference'] ?? null),
                'model_override' => $host['model_override'] ?? null,
                'reasoning_effort_override' => $host['reasoning_effort_override'] ?? null,
                'auto_update_override' => isset($host['auto_update_override']) ? ($host['auto_update_override'] === null ? null : (bool) (int) $host['auto_update_override']) : null,
                'effective_auto_update_enabled' => $autoUpdateState['effective_enabled'],
                'auto_update_state' => $autoUpdateState['state'],
                'auto_update_label' => $autoUpdateState['label'],
                'auto_update_emoji' => $autoUpdateState['emoji'],
                'auto_update_rank' => $autoUpdateState['rank'],
                'auto_update_last_event_at' => $autoUpdateState['last_event_at'],
                'auto_update_target_version' => $autoUpdateState['target_version'],
                'canonical_digest' => $host['auth_digest'] ?? null,
                'recent_digests' => array_values(array_unique($hostDigests)),
                'authed' => ($host['auth_digest'] ?? '') !== '',
                'auth_outdated' => $canonicalDigest !== null
                    && isset($host['auth_digest'])
                    && (string) $host['auth_digest'] !== (string) $canonicalDigest,
                'auth_source' => $canonicalSourceHostId !== null && (int) $host['id'] === $canonicalSourceHostId,
                'token_usage' => $tokenUsageMap[(int) $host['id']] ?? null,
                'users' => $usersMap[(int) $host['id']] ?? [],
            ];
        }

        Response::json([
            'status' => 'ok',
            'data' => [
                'hosts' => $items,
            ],
        ]);
    }

    /**
     * GET /admin/hosts/{id}/detail
     */
    public function hostDetail(int $hostId): void
    {
        requireAdminAccess();

        $host = $this->hostRepository->findById($hostId);
        if ($host === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $canonicalDigest = null;
        $canonicalSourceHostId = null;
        $canonicalPayloadId = $this->versionRepository->get('canonical_payload_id');
        if ($canonicalPayloadId !== null && ctype_digit((string) $canonicalPayloadId)) {
            $canonicalPayload = $this->authPayloadRepository->findByIdWithEntries((int) $canonicalPayloadId);
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

        $versionSummary = $this->service->versionSummary();
        $hostVersions = $this->service->applyClientVersionOverrideForHost($versionSummary, $host);
        $globalAutoUpdateEnabled = (bool) ($versionSummary['auto_update_enabled'] ?? false);
        $cronEvents = $this->logRepository->latestByHostAndActions([$hostId], [
            'cron.update_available',
            'cron.update_reported',
        ]);
        $hostCronEvents = $cronEvents[$hostId] ?? [];
        $autoUpdateState = $this->deriveAutoUpdateState($host, $hostVersions, $globalAutoUpdateEnabled, $hostCronEvents);
        $tokenUsage = $this->tokenUsageRepository->latestForHost($hostId);
        $users = $this->hostUserRepository->listByHost($hostId);
        $hostDigests = $this->digestRepository->recentDigests($hostId);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => (int) $host['id'],
                    'fqdn' => $host['fqdn'],
                    'status' => $host['status'],
                    'last_refresh' => $this->normalizeIsoTimestamp($host['last_refresh'] ?? null),
                    'updated_at' => $this->normalizeIsoTimestamp($host['updated_at'] ?? null),
                    'created_at' => $this->normalizeIsoTimestamp($host['created_at'] ?? null),
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
                    'insecure_enabled_until' => $this->normalizeIsoTimestamp($host['insecure_enabled_until'] ?? null),
                    'insecure_grace_until' => $this->normalizeIsoTimestamp($host['insecure_grace_until'] ?? null),
                    'insecure_window_minutes' => isset($host['insecure_window_minutes']) && $host['insecure_window_minutes'] !== null
                        ? (int) $host['insecure_window_minutes']
                        : null,
                    'curl_insecure' => isset($host['curl_insecure']) ? (bool) (int) $host['curl_insecure'] : false,
                    'last_cron_check' => $this->normalizeIsoTimestamp($host['last_cron_check'] ?? null),
                    'reverse_dns_mode' => formatReverseDnsModeOutput($host['reverse_dns_mode'] ?? null),
                    'lane_preference' => AuthService::normalizeQuotaLane($host['lane_preference'] ?? null),
                    'model_override' => $host['model_override'] ?? null,
                    'reasoning_effort_override' => $host['reasoning_effort_override'] ?? null,
                    'auto_update_override' => isset($host['auto_update_override']) ? ($host['auto_update_override'] === null ? null : (bool) (int) $host['auto_update_override']) : null,
                    'effective_auto_update_enabled' => $autoUpdateState['effective_enabled'],
                    'auto_update_state' => $autoUpdateState['state'],
                    'auto_update_label' => $autoUpdateState['label'],
                    'auto_update_emoji' => $autoUpdateState['emoji'],
                    'auto_update_rank' => $autoUpdateState['rank'],
                    'auto_update_last_event_at' => $autoUpdateState['last_event_at'],
                    'auto_update_target_version' => $autoUpdateState['target_version'],
                    'canonical_digest' => $host['auth_digest'] ?? null,
                    'recent_digests' => array_values(array_unique($hostDigests)),
                    'authed' => ($host['auth_digest'] ?? '') !== '',
                    'auth_outdated' => $canonicalDigest !== null
                        && isset($host['auth_digest'])
                        && (string) $host['auth_digest'] !== (string) $canonicalDigest,
                    'auth_source' => $canonicalSourceHostId !== null && (int) $host['id'] === $canonicalSourceHostId,
                    'token_usage' => $tokenUsage,
                    'users' => $users,
                ],
                'overview' => [
                    'versions' => [
                        'client_version' => $versionSummary['client_version'] ?? null,
                        'wrapper_version' => $versionSummary['wrapper_version'] ?? null,
                        'client_version_checked_at' => $versionSummary['client_version_checked_at'] ?? null,
                    ],
                    'reverse_dns_enabled' => $this->versionRepository->getFlag('reverse_dns_enabled', false),
                    'auto_update_enabled' => $globalAutoUpdateEnabled,
                    'inactivity_window_days' => $this->service->inactivityWindowDays(),
                ],
            ],
        ]);
    }

    /**
     * GET /admin/hosts/insecure
     */
    public function hostsInsecure(): void
    {
        requireAdminAccess();
        $this->service->pruneStaleHosts();

        $hosts = $this->hostRepository->all();

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
        $domainRows = $this->insecureDomainAllowRepository->listAll();
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
    }

    /**
     * POST /admin/hosts/insecure/extend
     */
    public function hostsInsecureExtend(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
        $this->service->pruneStaleHosts();

        $hosts = $this->hostRepository->all();
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
            $graceUntil = $this->service->resolveInsecureGraceUntil($newUntil, $minutes);
            $this->hostRepository->updateInsecureWindows((int) $host['id'], $newUntil, $graceUntil, null);
            $this->logRepository->log((int) $host['id'], 'admin.host.insecure_extend', [
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
    }

    /**
     * POST /admin/hosts/insecure/disable-all
     */
    public function hostsInsecureDisableAll(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
        $this->service->pruneStaleHosts();

        $hosts = $this->hostRepository->all();
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

            $this->hostRepository->updateInsecureWindows((int) $host['id'], null, null);
            $this->logRepository->log((int) $host['id'], 'admin.host.insecure_disable', [
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
    }

    /**
     * GET /admin/logs
     */
    public function logs(): void
    {
        requireAdminAccess();

        $limit = resolveIntQuery('limit') ?? 50;
        if ($limit < 1) {
            $limit = 50;
        }

        $logs = $this->logRepository->recent($limit);

        Response::json([
            'status' => 'ok',
            'data' => [
                'logs' => $logs,
            ],
        ]);
    }

    /**
     * GET /admin/usage/ingests
     */
    public function usageIngests(): void
    {
        requireAdminAccess();

        $page = resolveIntQuery('page') ?? 1;
        $perPage = resolveIntQuery('per_page') ?? 50;
        $hostId = resolveIntQuery('host_id');
        $query = isset($_GET['q']) && !is_array($_GET['q']) ? trim((string) $_GET['q']) : null;
        $sort = isset($_GET['sort']) && !is_array($_GET['sort']) ? (string) $_GET['sort'] : 'created_at';
        $direction = isset($_GET['direction']) && !is_array($_GET['direction']) ? (string) $_GET['direction'] : 'desc';

        $result = $this->tokenUsageIngestRepository->search($query, $hostId, $page, $perPage, $sort, $direction);
        $pricing = $this->pricingService->latestPricing($this->pricingModel, false);
        $currency = isset($pricing['currency']) && is_string($pricing['currency']) ? $pricing['currency'] : 'USD';
        $result['currency'] = $currency;

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/usage
     */
    public function usage(): void
    {
        requireAdminAccess();

        $limit = resolveIntQuery('limit') ?? 50;
        if ($limit < 1) {
            $limit = 50;
        }

        $usages = $this->tokenUsageRepository->recent($limit);

        Response::json([
            'status' => 'ok',
            'data' => [
                'usages' => $usages,
            ],
        ]);
    }

    /**
     * GET /admin/usage/cost-history
     */
    public function usageCostHistory(): void
    {
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

        $history = $this->costHistoryService->historyAdvanced($days, $from, $until, $interval, $groupBy, $includeTokens);

        Response::json([
            'status' => 'ok',
            'data' => $history,
        ]);
    }

    /**
     * GET /admin/chatgpt/usage
     */
    public function chatgptUsage(): void
    {
        requireAdminAccess();
        $force = isset($_GET['force']) && $_GET['force'] !== '0';
        $result = $this->chatGptUsageService->fetchLatest($force);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/chatgpt/usage/history
     */
    public function chatgptUsageHistory(): void
    {
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

        $history = $this->chatGptUsageService->historyAdvanced($days, $from, $until, $interval, $lane, $window);

        Response::json([
            'status' => 'ok',
            'data' => $history,
        ]);
    }

    /**
     * POST /admin/chatgpt/usage/refresh
     */
    public function chatgptUsageRefresh(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);
        $result = $this->chatGptUsageService->fetchLatest(true);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * GET /admin/tokens
     */
    public function tokens(): void
    {
        requireAdminAccess();

        $limit = resolveIntQuery('limit') ?? 50;
        if ($limit < 1) {
            $limit = 50;
        }

        $tokens = $this->tokenUsageRepository->topTokens($limit);

        Response::json([
            'status' => 'ok',
            'data' => [
                'tokens' => $tokens,
            ],
        ]);
    }

    private function deriveAutoUpdateState(array $host, array $versions, bool $globalAutoUpdateEnabled, array $cronEvents): array
    {
        $override = $host['auto_update_override'] ?? null;
        $effectiveEnabled = $override === null
            ? $globalAutoUpdateEnabled
            : (bool) $override;

        $lastCronCheck = $this->normalizeIsoTimestamp($host['last_cron_check'] ?? null);
        $recentCheck = $this->isRecentTimestamp($lastCronCheck, 86400);

        $targetVersion = CodexVersionPolicy::normalize($versions['client_version'] ?? null);
        $hostVersion = CodexVersionPolicy::normalize($host['client_version'] ?? null);
        $targetWrapperVersion = CodexVersionPolicy::normalize($versions['wrapper_version'] ?? null);
        $hostWrapperVersion = CodexVersionPolicy::normalize($host['wrapper_version'] ?? null);
        $targetCheckedAt = $this->normalizeIsoTimestamp($versions['client_version_checked_at'] ?? null);
        $clientUpdateNeeded = $this->isHostBehindTarget(
            $hostVersion,
            $targetVersion,
            (bool) ($versions['client_version_enforce_exact'] ?? false)
        );
        $wrapperUpdateNeeded = $targetWrapperVersion !== null
            && ($hostWrapperVersion === null || $hostWrapperVersion !== $targetWrapperVersion);
        $updateNeeded = $clientUpdateNeeded || $wrapperUpdateNeeded;

        $availableEvent = $cronEvents['cron.update_available'] ?? null;
        $reportedEvent = $cronEvents['cron.update_reported'] ?? null;
        $availableAt = $this->normalizeIsoTimestamp($availableEvent['created_at'] ?? null);
        $reportedAt = $this->normalizeIsoTimestamp($reportedEvent['created_at'] ?? null);
        $reportedAfterAvailable = $reportedAt !== null
            && ($availableAt === null || strtotime($reportedAt) >= strtotime($availableAt));

        if (!$effectiveEnabled) {
            if ($recentCheck) {
                return [
                    'effective_enabled' => false,
                    'state' => 'disabled_but_cron_running',
                    'label' => 'Cron still running while auto-updates are disabled',
                    'emoji' => '⚠️',
                    'rank' => 1,
                    'last_event_at' => $lastCronCheck,
                    'target_version' => $targetVersion ?? $targetWrapperVersion,
                ];
            }

            return [
                'effective_enabled' => false,
                'state' => 'disabled_idle',
                'label' => 'Auto-updates disabled',
                'emoji' => '-',
                'rank' => 2,
                'last_event_at' => $lastCronCheck,
                'target_version' => $targetVersion ?? $targetWrapperVersion,
            ];
        }

        if (!$recentCheck) {
            return [
                'effective_enabled' => true,
                'state' => 'enabled_missing_checkin',
                'label' => 'Expected daily cron check-in is missing',
                'emoji' => '⚠️',
                'rank' => 1,
                'last_event_at' => $lastCronCheck,
                'target_version' => $targetVersion ?? $targetWrapperVersion,
            ];
        }

        $clientAtTarget = $targetVersion === null
            || ($hostVersion !== null && $hostVersion === $targetVersion);
        $wrapperAtTarget = $targetWrapperVersion === null
            || ($hostWrapperVersion !== null && $hostWrapperVersion === $targetWrapperVersion);
        $hostAtTarget = $clientAtTarget && $wrapperAtTarget;
        $newReleaseSinceCheck = $clientUpdateNeeded
            && $lastCronCheck !== null
            && $targetCheckedAt !== null
            && strtotime($targetCheckedAt) > strtotime($lastCronCheck);

        if ($hostAtTarget && $reportedAfterAvailable) {
            return [
                'effective_enabled' => true,
                'state' => 'enabled_update_succeeded',
                'label' => 'Checked in and auto-update succeeded for Codex and wrapper',
                'emoji' => '✅',
                'rank' => 0,
                'last_event_at' => $reportedAt ?? $lastCronCheck,
                'target_version' => $targetVersion ?? $targetWrapperVersion,
            ];
        }

        if ($newReleaseSinceCheck) {
            return [
                'effective_enabled' => true,
                'state' => 'enabled_checked_before_new_release',
                'label' => 'Checked in earlier, but a newer release appeared since then',
                'emoji' => '⚠️',
                'rank' => 1,
                'last_event_at' => $targetCheckedAt,
                'target_version' => $targetVersion ?? $targetWrapperVersion,
            ];
        }

        if ($updateNeeded) {
            $label = $clientUpdateNeeded && $wrapperUpdateNeeded
                ? 'Checked in, but Codex and wrapper still need updates'
                : ($wrapperUpdateNeeded
                    ? 'Checked in, but wrapper still needs an update'
                    : 'Checked in, but Codex still needs an update');
            return [
                'effective_enabled' => true,
                'state' => 'enabled_checked_update_needed',
                'label' => $label,
                'emoji' => '⚠️',
                'rank' => 1,
                'last_event_at' => $availableAt ?? $lastCronCheck,
                'target_version' => $targetVersion ?? $targetWrapperVersion,
            ];
        }

        return [
            'effective_enabled' => true,
            'state' => 'enabled_current_checked',
            'label' => 'Checked in and already current for Codex and wrapper',
            'emoji' => '✅',
            'rank' => 0,
            'last_event_at' => $lastCronCheck,
            'target_version' => $targetVersion ?? $targetWrapperVersion,
        ];
    }

    private function normalizeIsoTimestamp($value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        try {
            return (new DateTimeImmutable((string) $value))->format(DATE_ATOM);
        } catch (\Exception) {
            return is_string($value) ? $value : null;
        }
    }

    private function isRecentTimestamp(?string $value, int $windowSeconds): bool
    {
        if ($value === null) {
            return false;
        }

        $timestamp = strtotime($value);
        if ($timestamp === false) {
            return false;
        }

        $age = time() - $timestamp;
        return $age >= 0 && $age <= $windowSeconds;
    }

    private function isHostBehindTarget(?string $hostVersion, ?string $targetVersion, bool $enforceExact): bool
    {
        if ($targetVersion === null) {
            return false;
        }
        if ($hostVersion === null) {
            return true;
        }
        if ($enforceExact) {
            return $hostVersion !== $targetVersion;
        }

        return version_compare($hostVersion, $targetVersion, '<');
    }

    private function logRetentionDays(string $key, int $default): int
    {
        $raw = $this->versionRepository->get($key);
        if ($raw === null || !is_numeric($raw)) {
            return $default;
        }
        $days = (int) $raw;
        if ($days < 1) {
            return 1;
        }
        if ($days > 365) {
            return 365;
        }
        return $days;
    }
}
