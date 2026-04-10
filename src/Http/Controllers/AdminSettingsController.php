<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\AdminAuthService;
use App\Services\UsageScalingService;
use App\Support\AdminTheme;
use App\Support\CodexVersionPolicy;

class AdminSettingsController
{
    public function __construct(
        private AuthService $service,
        private VersionRepository $versionRepository,
        private LogRepository $logRepository,
        private ?UsageScalingService $usageScalingService = null,
    ) {}

    /**
     * GET /admin/api/state
     */
    public function getApiState(): void
    {
        requireAdminAccess();

        $disabled = $this->versionRepository->getFlag('api_disabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    /**
     * POST /admin/api/state
     */
    public function postApiState(array $payload): void
    {
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

        $this->versionRepository->set('api_disabled', $disabled ? '1' : '0');
        $this->logRepository->log(null, 'admin.api.state', [
            'disabled' => $disabled,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    /**
     * GET /admin/openai/state
     */
    public function getOpenaiApiState(): void
    {
        requireAdminAccess();

        $disabled = $this->versionRepository->getFlag('openai_api_disabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    /**
     * POST /admin/openai/state
     */
    public function postOpenaiApiState(array $payload): void
    {
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

        $this->versionRepository->set('openai_api_disabled', $disabled ? '1' : '0');
        $this->logRepository->log(null, 'admin.openai_api.state', [
            'disabled' => $disabled,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    /**
     * GET /admin/claude/state
     */
    public function getClaudeApiState(): void
    {
        requireAdminAccess();

        $disabled = $this->versionRepository->getFlag('claude_api_disabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    /**
     * POST /admin/claude/state
     */
    public function postClaudeApiState(array $payload): void
    {
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

        $this->versionRepository->set('claude_api_disabled', $disabled ? '1' : '0');
        $this->logRepository->log(null, 'admin.claude_api.state', [
            'disabled' => $disabled,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['disabled' => $disabled],
        ]);
    }

    /**
     * GET /admin/claude/settings
     */
    public function getClaudeSettings(): void
    {
        requireAdminAccess();

        Response::json([
            'status' => 'ok',
            'data' => [
                'default_model' => $this->versionRepository->get('claude_default_model') ?? 'claude-sonnet-4-6',
                'max_tokens' => (int) ($this->versionRepository->get('claude_max_tokens') ?? 8192),
                'spend_limit' => (float) ($this->versionRepository->get('claude_spend_limit') ?? 0),
                'disabled' => $this->versionRepository->getFlag('claude_api_disabled', false),
            ],
        ]);
    }

    /**
     * POST /admin/claude/settings
     */
    public function postClaudeSettings(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $supported = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5'];

        if (isset($payload['default_model'])) {
            $model = trim((string) $payload['default_model']);
            if (in_array($model, $supported, true)) {
                $this->versionRepository->set('claude_default_model', $model);
            }
        }
        if (isset($payload['max_tokens'])) {
            $tokens = (int) $payload['max_tokens'];
            if ($tokens >= 256 && $tokens <= 200000) {
                $this->versionRepository->set('claude_max_tokens', (string) $tokens);
            }
        }
        if (isset($payload['spend_limit'])) {
            $limit = (float) $payload['spend_limit'];
            if ($limit >= 0) {
                $this->versionRepository->set('claude_spend_limit', (string) $limit);
            }
        }

        $this->logRepository->log(null, 'admin.claude_settings', array_filter($payload));

        // Return current state
        $this->getClaudeSettings();
    }

    /**
     * GET /admin/cdx-silent
     */
    public function getCdxSilent(): void
    {
        requireAdminAccess();

        $silent = $this->versionRepository->getFlag('cdx_silent', false);

        Response::json([
            'status' => 'ok',
            'data' => ['silent' => $silent],
        ]);
    }

    /**
     * POST /admin/cdx-silent
     */
    public function postCdxSilent(array $payload): void
    {
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

        $this->versionRepository->set('cdx_silent', $silent ? '1' : '0');
        $this->logRepository->log(null, 'admin.cdx_silent', [
            'silent' => $silent,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['silent' => $silent],
        ]);
    }

    /**
     * GET /admin/theme
     */
    public function getTheme(): void
    {
        requireAdminAccess();

        Response::json([
            'status' => 'ok',
            'data' => [
                'theme' => AdminTheme::normalize($this->versionRepository->get('admin_theme')),
            ],
        ]);
    }

    /**
     * POST /admin/theme
     */
    public function postTheme(array $payload): void
    {
        requireAdminAccess();

        if (!array_key_exists('theme', $payload)) {
            Response::json([
                'status' => 'error',
                'message' => 'theme is required',
            ], 422);
        }

        $rawTheme = $payload['theme'] ?? null;
        if (!is_string($rawTheme)) {
            Response::json([
                'status' => 'error',
                'message' => 'theme must be one of: auto, auto-pink, light, dark, bright-pink, dark-pink',
            ], 422);
        }

        $theme = AdminTheme::normalize($rawTheme);
        if ($theme !== trim(strtolower($rawTheme))) {
            Response::json([
                'status' => 'error',
                'message' => 'theme must be one of: auto, auto-pink, light, dark, bright-pink, dark-pink',
            ], 422);
        }

        $this->versionRepository->set('admin_theme', $theme);
        $this->logRepository->log(null, 'admin.theme', [
            'theme' => $theme,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['theme' => $theme],
        ]);
    }

    /**
     * GET /admin/reverse-dns
     */
    public function getReverseDns(): void
    {
        requireAdminAccess();

        $enabled = $this->versionRepository->getFlag('reverse_dns_enabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['enabled' => $enabled],
        ]);
    }

    /**
     * POST /admin/reverse-dns
     */
    public function postReverseDns(array $payload): void
    {
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

        $this->versionRepository->set('reverse_dns_enabled', $enabled ? '1' : '0');
        $this->logRepository->log(null, 'admin.reverse_dns', [
            'enabled' => $enabled,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['enabled' => $enabled],
        ]);
    }

    /**
     * GET /admin/auto-update
     */
    public function getAutoUpdate(): void
    {
        requireAdminAccess();

        $enabled = $this->versionRepository->getFlag('auto_update_enabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['enabled' => $enabled],
        ]);
    }

    /**
     * POST /admin/auto-update
     */
    public function postAutoUpdate(array $payload): void
    {
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

        $this->versionRepository->set('auto_update_enabled', $enabled ? '1' : '0');
        $this->logRepository->log(null, 'admin.auto_update', [
            'enabled' => $enabled,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['enabled' => $enabled],
        ]);
    }

    /**
     * GET /admin/insecure-approval
     */
    public function getInsecureApproval(): void
    {
        requireAdminAccess();

        $enabled = $this->versionRepository->getFlag('insecure_approval_enabled', false);

        Response::json([
            'status' => 'ok',
            'data' => ['enabled' => $enabled],
        ]);
    }

    /**
     * POST /admin/insecure-approval
     */
    public function postInsecureApproval(array $payload): void
    {
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

        $this->versionRepository->set('insecure_approval_enabled', $enabled ? '1' : '0');
        $this->logRepository->log(null, 'admin.insecure_approval', [
            'enabled' => $enabled,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['enabled' => $enabled],
        ]);
    }

    /**
     * POST /admin/codex-version
     */
    public function postCodexVersion(array $payload): void
    {
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
            $this->versionRepository->delete('client_version_lock');
            // Opportunistically refresh the cached GitHub latest value so dashboards update quickly.
            $this->service->availableClientVersion(true);
        } else {
            $normalized = CodexVersionPolicy::normalize($selection);
            if (!CodexVersionPolicy::isSemanticVersion($normalized)) {
                Response::json([
                    'status' => 'error',
                    'message' => 'selection must be a semantic version like 0.114.0',
                ], 422);
            }
            $effective = CodexVersionPolicy::resolveEffective($normalized, true)['version'];
            $this->versionRepository->set('client_version_lock', $effective);
            $logSelection = $effective;
        }

        $lock = $this->versionRepository->getWithMetadata('client_version_lock');
        $this->logRepository->log(null, 'admin.codex_version', [
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
    }

    /**
     * GET /admin/quota-mode
     */
    public function getQuotaMode(): void
    {
        requireAdminAccess();

        $hardFail = $this->versionRepository->getFlag('quota_hard_fail', true);
        $limitPercent = quotaLimitPercent($this->versionRepository);
        $weekPartition = quotaWeekPartition($this->versionRepository);

        Response::json([
            'status' => 'ok',
            'data' => [
                'hard_fail' => $hardFail,
                'limit_percent' => $limitPercent,
                'week_partition' => $weekPartition,
            ],
        ]);
    }

    /**
     * POST /admin/quota-mode
     */
    public function postQuotaMode(array $payload): void
    {
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
            ? quotaLimitPercent($this->versionRepository)
            : AuthService::normalizeQuotaLimitPercent($limitRaw);
        if ($limitRaw !== null && $limitPercent === null) {
            Response::json([
                'status' => 'error',
                'message' => sprintf('limit_percent must be between %d and %d', AuthService::MIN_QUOTA_LIMIT_PERCENT, AuthService::MAX_QUOTA_LIMIT_PERCENT),
            ], 422);
        }

        $partitionRaw = $payload['week_partition'] ?? null;
        $weekPartition = $partitionRaw === null
            ? quotaWeekPartition($this->versionRepository)
            : AuthService::normalizeQuotaWeekPartition($partitionRaw);
        if ($partitionRaw !== null && $weekPartition === null) {
            Response::json([
                'status' => 'error',
                'message' => 'week_partition must be one of: off, 7, 5',
            ], 422);
        }

        $this->versionRepository->set('quota_hard_fail', $hardFail ? '1' : '0');
        $this->versionRepository->set('quota_limit_percent', (string) $limitPercent);
        $this->versionRepository->set('quota_week_partition', (string) $weekPartition);
        $this->logRepository->log(null, 'admin.quota_mode', [
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
    }

    /**
     * POST /admin/prune-policy
     */
    public function postPrunePolicy(array $payload): void
    {
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

        $this->versionRepository->set('inactivity_window_days', (string) $days);
        $this->logRepository->log(null, 'admin.prune_policy', [
            'inactivity_window_days' => $days,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'inactivity_window_days' => $days,
            ],
        ]);
    }

    /**
     * GET /admin/log-retention
     */
    public function getLogRetention(): void
    {
        requireAdminAccess();

        $enabled = $this->versionRepository->getFlag('log_retention_enabled', false);
        $daysLogs = $this->logRetentionDays('log_retention_days_logs', 90);
        $daysMcp = $this->logRetentionDays('log_retention_days_mcp', 90);
        $daysEvents = $this->logRetentionDays('log_retention_days_events', 30);
        $daysGraphStats = $this->logRetentionDays('log_retention_days_graph_stats', 180);

        Response::json([
            'status' => 'ok',
            'data' => [
                'enabled' => $enabled,
                'days_logs' => $daysLogs,
                'days_mcp' => $daysMcp,
                'days_events' => $daysEvents,
                'days_graph_stats' => $daysGraphStats,
            ],
        ]);
    }

    /**
     * POST /admin/log-retention
     */
    public function postLogRetention(array $payload): void
    {
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

        $daysLogs = $this->clampRetentionDays($payload['days_logs'] ?? null, 90);
        $daysMcp = $this->clampRetentionDays($payload['days_mcp'] ?? null, 90);
        $daysEvents = $this->clampRetentionDays($payload['days_events'] ?? null, 30);
        $daysGraphStats = $this->clampRetentionDays($payload['days_graph_stats'] ?? null, 180);

        $this->versionRepository->set('log_retention_enabled', $enabled ? '1' : '0');
        $this->versionRepository->set('log_retention_days_logs', (string) $daysLogs);
        $this->versionRepository->set('log_retention_days_mcp', (string) $daysMcp);
        $this->versionRepository->set('log_retention_days_events', (string) $daysEvents);
        $this->versionRepository->set('log_retention_days_graph_stats', (string) $daysGraphStats);

        $this->logRepository->log(null, 'admin.log_retention', [
            'enabled' => $enabled,
            'days_logs' => $daysLogs,
            'days_mcp' => $daysMcp,
            'days_events' => $daysEvents,
            'days_graph_stats' => $daysGraphStats,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'enabled' => $enabled,
                'days_logs' => $daysLogs,
                'days_mcp' => $daysMcp,
                'days_events' => $daysEvents,
                'days_graph_stats' => $daysGraphStats,
            ],
        ]);
    }

    private function logRetentionDays(string $key, int $default): int
    {
        $raw = $this->versionRepository->get($key);
        if ($raw === null || !is_numeric($raw)) {
            return $default;
        }
        return $this->clampRetentionDays((int) $raw, $default);
    }

    private function clampRetentionDays(mixed $value, int $default): int
    {
        if ($value === null || !is_numeric($value)) {
            return $default;
        }
        $days = (int) $value;
        if ($days < 1) {
            return 1;
        }
        if ($days > 365) {
            return 365;
        }
        return $days;
    }

    /**
     * POST /admin/versions/check
     */
    public function versionsCheck(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $available = $this->service->availableClientVersion(true);
        $versions = $this->service->versionSummary();

        Response::json([
            'status' => 'ok',
            'data' => [
                'available_client' => $available,
                'versions' => $versions,
            ],
        ]);
    }

    /**
     * GET /admin/scaling
     */
    public function getScaling(): void
    {
        requireAdminAccess();

        if ($this->usageScalingService === null) {
            Response::json(['status' => 'ok', 'data' => ['enabled' => false, 'rules' => null]]);
            return;
        }

        Response::json([
            'status' => 'ok',
            'data' => $this->usageScalingService->currentStatus(),
        ]);
    }

    /**
     * POST /admin/scaling
     */
    public function postScaling(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        if ($this->usageScalingService === null) {
            Response::json(['status' => 'error', 'message' => 'Scaling service not available'], 503);
            return;
        }

        $rules = $payload;
        $errors = $this->usageScalingService->storeRules($rules);
        if ($errors !== []) {
            Response::json([
                'status' => 'error',
                'message' => 'Validation failed',
                'errors' => $errors,
            ], 422);
            return;
        }

        $this->logRepository->log(null, 'admin.scaling', [
            'enabled' => $rules['enabled'] ?? false,
            'tiers' => count($rules['tiers'] ?? []),
        ]);

        Response::json([
            'status' => 'ok',
            'data' => $this->usageScalingService->currentStatus(),
        ]);
    }
}
