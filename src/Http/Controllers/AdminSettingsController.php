<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\AdminAuthService;
use App\Support\CodexVersionPolicy;

class AdminSettingsController
{
    public function __construct(
        private AuthService $service,
        private VersionRepository $versionRepository,
        private LogRepository $logRepository,
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
}
