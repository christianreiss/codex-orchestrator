<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Repositories\HostRepository;
use App\Repositories\VersionRepository;
use App\Support\CodexVersionPolicy;

class ClientVersionService
{
    private const VERSION_CACHE_TTL_SECONDS = 10800; // 3 hours
    private const CLIENT_VERSION_LOCK_KEY = 'client_version_lock';

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly VersionRepository $versions,
        private readonly WrapperService $wrapperService,
        private readonly ?RunnerVerifier $runnerVerifier,
        private readonly ?string $installationId
    ) {
    }

    public function versionSnapshot(?array $wrapperMetaOverride = null): array
    {
        $locked = $this->versions->getWithMetadata(self::CLIENT_VERSION_LOCK_KEY);
        $lockedVersion = $this->canonicalVersion($locked['version'] ?? null);
        $available = $lockedVersion !== null
            ? [
                'version' => $lockedVersion,
                'updated_at' => $locked['updated_at'] ?? null,
                'source' => 'locked',
            ]
            : $this->availableClientVersion();
        $wrapperMeta = $wrapperMetaOverride ?? $this->wrapperService->metadata();
        $reported = $this->latestReportedVersions();

        $clientPolicy = CodexVersionPolicy::resolveEffective(
            $available['version'] ?? null,
            $lockedVersion !== null
        );
        $clientVersion = $clientPolicy['version'];
        $clientCheckedAt = $available['updated_at'] ?? null;
        $clientSource = $available['source'] ?? null;

        $wrapperVersion = $this->canonicalVersion($wrapperMeta['version'] ?? null);

        return [
            'client_version' => $clientVersion,
            'client_version_checked_at' => $clientCheckedAt,
            'client_version_source' => $clientSource,
            'client_version_enforce_exact' => $clientPolicy['enforce_exact'],
            'wrapper_version' => $wrapperVersion,
            'wrapper_sha256' => $wrapperMeta['sha256'] ?? null,
            'wrapper_url' => $wrapperMeta['url'] ?? null,
            'reported_client_version' => $reported['client_version'],
            'reported_wrapper_version' => $reported['wrapper_version'],
            'quota_hard_fail' => $this->versions->getFlag('quota_hard_fail', true),
            'quota_limit_percent' => $this->quotaLimitPercent(),
            'quota_week_partition' => $this->quotaWeekPartition(),
            'cdx_silent' => $this->versions->getFlag('cdx_silent', false),
            'runner_enabled' => $this->runnerVerifier !== null,
            'runner_state' => $this->versions->get('runner_state'),
            'runner_last_ok' => $this->versions->get('runner_last_ok'),
            'runner_last_fail' => $this->versions->get('runner_last_fail'),
            'runner_last_check' => $this->versions->get('runner_last_check'),
            'installation_id' => $this->installationId,
            'auto_update_enabled' => $this->versions->getFlag('auto_update_enabled', false),
        ];
    }

    public function applyClientVersionOverrideForHost(array $versions, array $host): array
    {
        $override = $host['client_version_override'] ?? null;
        if (!is_string($override)) {
            return $versions;
        }

        $override = trim($override);
        if ($override === '' || strtolower($override) === 'global') {
            return $versions;
        }

        $policy = CodexVersionPolicy::resolveEffective($override, true);

        $versions['client_version'] = $policy['version'];
        $versions['client_version_source'] = 'locked';
        $versions['client_version_checked_at'] = null;
        $versions['client_version_enforce_exact'] = $policy['enforce_exact'];

        return $versions;
    }

    public function availableClientVersion(bool $forceRefresh = false): array
    {
        $cached = $this->versions->getWithMetadata('client_available');
        $now = time();
        $cacheFresh = false;

        if (!$forceRefresh && $cached && isset($cached['updated_at'])) {
            $updatedAt = strtotime($cached['updated_at']);
            if ($updatedAt !== false && ($now - $updatedAt) <= self::VERSION_CACHE_TTL_SECONDS) {
                $cacheFresh = true;
            }
        }

        $cachedVersion = $this->canonicalVersion($cached['version'] ?? null);

        if ($cacheFresh && $cachedVersion !== null) {
            return [
                'version' => $cachedVersion,
                'updated_at' => $cached['updated_at'] ?? null,
                'source' => 'cache',
            ];
        }

        $fetched = $this->fetchLatestCodexVersion();
        if ($fetched !== null) {
            $normalized = $this->canonicalVersion($fetched) ?? $fetched;
            $this->versions->set('client_available', $normalized);
            return [
                'version' => $normalized,
                'updated_at' => gmdate(DATE_ATOM),
                'source' => 'github',
            ];
        }

        if ($cachedVersion !== null) {
            return [
                'version' => $cachedVersion,
                'updated_at' => $cached['updated_at'] ?? null,
                'source' => 'cache_stale',
            ];
        }

        return [
            'version' => null,
            'updated_at' => null,
            'source' => 'unknown',
        ];
    }

    public function latestReportedVersions(): array
    {
        $hosts = $this->hosts->all();

        $latestClient = null;
        $latestWrapper = null;

        foreach ($hosts as $host) {
            $client = $host['client_version'] ?? null;
            if (is_string($client) && $client !== '') {
                if ($latestClient === null || $this->isVersionGreater($client, $latestClient)) {
                    $latestClient = $client;
                }
            }

            $wrapper = $host['wrapper_version'] ?? null;
            if (is_string($wrapper) && $wrapper !== '') {
                if ($latestWrapper === null || $this->isVersionGreater($wrapper, $latestWrapper)) {
                    $latestWrapper = $wrapper;
                }
            }
        }

        return [
            'client_version' => $this->canonicalVersion($latestClient),
            'wrapper_version' => $this->canonicalVersion($latestWrapper),
        ];
    }

    public function versionSummary(): array
    {
        return $this->versionSnapshot();
    }

    public function normalizeClientVersion(?string $clientVersion): string
    {
        $normalized = $this->canonicalVersion(is_string($clientVersion) ? $clientVersion : '');
        if ($normalized === null || $normalized === '') {
            $normalized = 'unknown';
        }

        return $normalized;
    }

    public function quotaLimitPercent(): int
    {
        $stored = $this->versions->get('quota_limit_percent');
        $normalized = AuthService::normalizeQuotaLimitPercent($stored);
        return $normalized ?? AuthService::DEFAULT_QUOTA_LIMIT_PERCENT;
    }

    public function quotaWeekPartition(): int
    {
        $stored = $this->versions->get('quota_week_partition');
        $normalized = AuthService::normalizeQuotaWeekPartition($stored);
        return $normalized ?? AuthService::DEFAULT_QUOTA_WEEK_PARTITION;
    }

    private function isVersionGreater(string $left, string $right): bool
    {
        $left = $this->normalizeVersionString($left);
        $right = $this->normalizeVersionString($right);

        if ($left === '') {
            return false;
        }
        if ($right === '') {
            return true;
        }

        $cmp = version_compare($left, $right);

        return $cmp === 1;
    }

    private function fetchLatestCodexVersion(): ?string
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => "User-Agent: codex-auth-api\r\nAccept: application/json\r\n",
                'timeout' => 5,
            ],
        ]);

        $json = @file_get_contents('https://api.github.com/repos/openai/codex/releases/latest', false, $context);
        if ($json === false) {
            return null;
        }

        $data = json_decode($json, true);
        if (!is_array($data)) {
            return null;
        }

        $candidates = [
            $data['tag_name'] ?? null,
            $data['name'] ?? null,
        ];

        foreach ($candidates as $candidate) {
            if (is_string($candidate)) {
                $normalized = $this->canonicalVersion($candidate);
                if ($normalized !== null && $normalized !== '') {
                    return $normalized;
                }
            }
        }

        return null;
    }

    private function normalizeVersionString(string $value): string
    {
        return CodexVersionPolicy::normalize($value) ?? '';
    }

    private function canonicalVersion(?string $value): ?string
    {
        return CodexVersionPolicy::normalize($value);
    }
}
