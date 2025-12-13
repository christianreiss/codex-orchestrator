<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Config;
use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Support\Timestamp;
use App\Security\RateLimiter;
use DateTimeImmutable;
use App\Services\WrapperService;
use App\Services\RunnerVerifier;

class AuthService
{
    private const DEFAULT_INACTIVITY_WINDOW_DAYS = 30;
    private const MAX_INACTIVITY_WINDOW_DAYS = 60;
    private const PROVISIONING_WINDOW_MINUTES = 30;
    public const MIN_INSECURE_WINDOW_MINUTES = 2;
    public const MAX_INSECURE_WINDOW_MINUTES = 60;
    public const DEFAULT_INSECURE_WINDOW_MINUTES = 10;
    public const MIN_QUOTA_LIMIT_PERCENT = 50;
    public const MAX_QUOTA_LIMIT_PERCENT = 100;
    public const DEFAULT_QUOTA_LIMIT_PERCENT = 100;
    public const QUOTA_WEEK_PARTITION_OFF = 0;
    public const QUOTA_WEEK_PARTITION_FIVE_DAY = 5;
    public const QUOTA_WEEK_PARTITION_SEVEN_DAY = 7;
    public const DEFAULT_QUOTA_WEEK_PARTITION = self::QUOTA_WEEK_PARTITION_OFF;
    private const VERSION_CACHE_TTL_SECONDS = 10800; // 3 hours
    private const MIN_LAST_REFRESH_EPOCH = 946684800; // 2000-01-01T00:00:00Z
    private const MAX_FUTURE_SKEW_SECONDS = 300; // allow small clock drift
    private const AUTH_FAIL_LIMIT = 20;
    private const AUTH_FAIL_WINDOW_SECONDS = 600;
    private const AUTH_FAIL_BLOCK_SECONDS = 1800;
    private const RUNNER_PREFLIGHT_INTERVAL_SECONDS = 28800; // 8 hours
    private const RUNNER_FAILURE_BACKOFF_SECONDS = 60;
    private const RUNNER_FAILURE_RETRY_SECONDS = 900; // 15 minutes
    private const RUNNER_STALE_OK_SECONDS = 21600; // 6 hours
    private const CLIENT_VERSION_LOCK_KEY = 'client_version_lock';
    private int $runnerPreflightIntervalSeconds;

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly AuthPayloadRepository $payloads,
        private readonly HostAuthStateRepository $hostStates,
        private readonly HostAuthDigestRepository $digests,
        private readonly HostUserRepository $hostUsers,
        private readonly LogRepository $logs,
        private readonly TokenUsageRepository $tokenUsages,
        private readonly TokenUsageIngestRepository $tokenUsageIngests,
        private readonly PricingService $pricingService,
        private readonly VersionRepository $versions,
        private readonly WrapperService $wrapperService,
        private readonly ?RunnerVerifier $runnerVerifier = null,
        private readonly ?RateLimiter $rateLimiter = null,
        private readonly ?string $installationId = null,
        ?int $runnerPreflightIntervalSeconds = null
    ) {
        $configuredInterval = $runnerPreflightIntervalSeconds ?? (int) Config::get('AUTH_RUNNER_PREFLIGHT_SECONDS', self::RUNNER_PREFLIGHT_INTERVAL_SECONDS);
        $this->runnerPreflightIntervalSeconds = $configuredInterval > 0 ? $configuredInterval : self::RUNNER_PREFLIGHT_INTERVAL_SECONDS;
    }

    public function register(string $fqdn, bool $secure = true): array
    {
        $this->pruneInactiveHosts();

        $errors = [];
        if ($fqdn === '') {
            $errors['fqdn'][] = 'FQDN is required';
        }

        if ($errors) {
            throw new ValidationException($errors);
        }

        $existing = $this->hosts->findByFqdn($fqdn);
        if ($existing) {
            $existingSecure = isset($existing['secure']) ? (bool) (int) $existing['secure'] : true;
            if ($existingSecure !== $secure) {
                $this->hosts->updateSecure((int) $existing['id'], $secure);
                $existing = $this->hosts->findByFqdn($fqdn) ?? $existing;
            }
            $apiKey = bin2hex(random_bytes(32));
            $host = $this->hosts->rotateApiKey((int) $existing['id'], $apiKey);
            if (!$secure) {
                $this->openInitialInsecureWindow((int) $existing['id']);
                $host = $this->hosts->findById((int) $existing['id']) ?? $host;
            }
            $this->logs->log((int) $existing['id'], 'register', ['result' => 'rotated']);
            $payload = $this->buildHostPayload($host ?? $existing, true);
            return $payload;
        }

        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create($fqdn, $apiKey, $secure);
        if (!$secure && isset($host['id'])) {
            $this->openInitialInsecureWindow((int) $host['id']);
            $host = $this->hosts->findById((int) $host['id']) ?? $host;
        }
        $this->logs->log((int) $host['id'], 'register', ['result' => 'created']);

        $payload = $this->buildHostPayload($host, true);
        // status report deprecated

        return $payload;
    }

    public function authenticate(?string $apiKey, ?string $ip = null, bool $allowIpBypass = false): array
    {
        $this->pruneInactiveHosts();

        if ($apiKey === null || $apiKey === '') {
            $this->throttleAuthFailures($ip, 'missing_api_key');
            throw new HttpException('API key missing', 401);
        }

        $host = $this->hosts->findByApiKey($apiKey);
        if (!$host) {
            $this->throttleAuthFailures($ip, 'invalid_api_key');
            throw new HttpException('Invalid API key', 401);
        }

        if (($host['status'] ?? '') !== 'active') {
            throw new HttpException('Host is disabled', 403);
        }

        $hostId = (int) $host['id'];
        $allowsRoaming = isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false;

        $ipAuthorized = true;
        $ipLogReason = 'none';

        if ($ip !== null && $ip !== '') {
            $storedIp = $host['ip'] ?? null;
            if ($storedIp === null || $storedIp === '') {
                $this->hosts->updateIp($hostId, $ip);
                $this->logs->log($hostId, 'auth.bind_ip', ['ip' => $ip]);
                $host = $this->hosts->findById($hostId) ?? $host;
                $ipLogReason = 'bound';
            } elseif (!hash_equals($storedIp, $ip)) {
                if ($allowsRoaming) {
                    $this->hosts->updateIp($hostId, $ip);
                    $this->logs->log($hostId, 'auth.roaming_ip', [
                        'previous_ip' => $storedIp,
                        'ip' => $ip,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                    $ipLogReason = 'roaming';
                } elseif ($allowIpBypass) {
                    $this->hosts->updateIp($hostId, $ip);
                    $this->logs->log($hostId, 'auth.force_ip_override', [
                        'previous_ip' => $storedIp,
                        'ip' => $ip,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                    $ipLogReason = 'force';
                } elseif ($this->shouldAllowRunnerIpBypass($ip)) {
                    // Runner needs to validate auth without rebinding host IP; do not update stored IP.
                    $this->logs->log($hostId, 'auth.runner_ip_bypass', [
                        'expected_ip' => $storedIp,
                        'ip' => $ip,
                    ]);
                    $ipLogReason = 'runner_bypass';
                } else {
                    $ipAuthorized = false;
                    $ipLogReason = 'mismatch';
                    error_log(sprintf(
                        '[auth] ip authorization=denied host=%s stored_ip=%s incoming_ip=%s reason=%s',
                        $host['fqdn'] ?? 'unknown',
                        $storedIp ?? 'none',
                        $ip,
                        $ipLogReason
                    ));
                    throw new HttpException('API key not allowed from this IP', 403, [
                        'expected_ip' => $storedIp,
                        'received_ip' => $ip,
                    ]);
                }
            }
        }

        if ($ip !== null && $ip !== '' && $ipAuthorized) {
            error_log(sprintf(
                '[auth] ip authorization=ok host=%s ip=%s reason=%s',
                $host['fqdn'] ?? 'unknown',
                $ip,
                $ipLogReason
            ));
        }

        return $host;
    }

    public function handleAuth(array $payload, array $host, ?string $clientVersion, ?string $wrapperVersion = null, ?string $baseUrl = null, bool $skipRunner = false): array
    {
        $incomingInstallation = isset($payload['installation_id']) && is_string($payload['installation_id'])
            ? trim($payload['installation_id'])
            : '';
        if ($incomingInstallation !== '' && $this->installationId !== null && $this->installationId !== '' && !hash_equals($this->installationId, $incomingInstallation)) {
            throw new HttpException('Installation ID mismatch', 403, ['code' => 'installation_mismatch']);
        }

        $normalizedClientVersion = $this->normalizeClientVersion($clientVersion);
        $normalizedWrapperVersion = $this->normalizeClientVersion($wrapperVersion);

        $command = $this->normalizeCommand($payload['command'] ?? null);

        $hostSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        $hostVip = isset($host['vip']) ? (bool) (int) $host['vip'] : false;
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : 0;
        $trackHost = $hostId > 0;
        $logHostId = $trackHost ? $hostId : null;

        if (!$hostSecure) {
            $host = $this->assertInsecureHostWindow($host, $hostId, $command, $trackHost);
        }

        if ($trackHost) {
            $this->hosts->updateClientVersions($hostId, $normalizedClientVersion, $normalizedWrapperVersion);
            $this->hosts->incrementApiCalls($hostId);
            $host = $this->hosts->findById($hostId) ?? $host;
        }

        $bakedWrapperMeta = null;
        if ($trackHost && $baseUrl !== null && $baseUrl !== '') {
            $bakedWrapperMeta = $this->wrapperService->bakedForHost($host, $baseUrl);
        }

        $monthStart = gmdate('Y-m-01\T00:00:00\Z');
        $monthEnd = gmdate('Y-m-01\T00:00:00\Z', strtotime('+1 month'));
        $hostTokenMonth = $trackHost ? $this->tokenUsages->totalsForHostRange($hostId, $monthStart, $monthEnd) : null;
        $hostStats = [
            'api_calls' => (int) ($host['api_calls'] ?? 0),
            'token_usage_month' => $hostTokenMonth,
        ];

        $versions = $this->versionSnapshot($bakedWrapperMeta);
        $quotaHardFail = $this->versions->getFlag('quota_hard_fail', true);
        if ($hostVip) {
            $quotaHardFail = false;
        }
        $quotaLimitPercent = $this->quotaLimitPercent();
        $quotaWeekPartition = $this->quotaWeekPartition();
        $cdxSilent = $this->versions->getFlag('cdx_silent', false);
        $canonicalPayload = $this->resolveCanonicalPayload();
        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;
        $canonicalAuthArray = null;

        if ($canonicalPayload !== null) {
            $validated = $this->validateCanonicalPayload($canonicalPayload);
            if ($validated !== null) {
                $canonicalAuthArray = $validated['auth'];
                $canonicalDigest = $validated['digest'];
                $canonicalLastRefresh = $validated['last_refresh'];
            } else {
                $canonicalPayload = null;
                $canonicalDigest = null;
                $canonicalLastRefresh = null;
            }
        }

        // Runner preflight: refresh canonical via runner on scheduled intervals before responding.
        if ($this->runnerVerifier !== null && !$skipRunner) {
            [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh] = $this->runnerDailyCheck($canonicalPayload, $host, $versions);
            if ($canonicalPayload !== null) {
                $validated = $this->validateCanonicalPayload($canonicalPayload);
                if ($validated !== null) {
                    $canonicalAuthArray = $validated['auth'];
                    $canonicalDigest = $validated['digest'];
                    $canonicalLastRefresh = $validated['last_refresh'];
                } else {
                    $canonicalPayload = null;
                    $canonicalAuthArray = null;
                    $canonicalDigest = null;
                    $canonicalLastRefresh = null;
                }
            } else {
                $canonicalAuthArray = null;
            }
        }

        if ($this->runnerVerifier !== null && !$skipRunner) {
            [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh] = $this->enforceRunnerValidationOnFailure(
                $canonicalPayload,
                $canonicalAuthArray,
                $host,
                $versions
            );
        }

        // Refresh the version snapshot after runner activity so we return the latest runner telemetry.
        $versions = $this->versionSnapshot($bakedWrapperMeta);

        $recentDigests = $trackHost ? $this->digests->recentDigests($hostId) : [];
        if ($trackHost && $canonicalDigest !== null && !in_array($canonicalDigest, $recentDigests, true)) {
            $this->digests->rememberDigests($hostId, [$canonicalDigest]);
            $recentDigests = $this->digests->recentDigests($hostId);
        }

        if ($command === 'retrieve') {
            $providedDigest = $this->extractDigest($payload, true);
            $incomingLastRefresh = $this->extractLastRefresh($payload, 'last_refresh');
            $this->assertReasonableLastRefresh($incomingLastRefresh, 'last_refresh');

            $status = 'missing';
            $response = [
                'status' => $status,
                'canonical_last_refresh' => $canonicalLastRefresh,
                'canonical_digest' => $canonicalDigest,
                'host' => $trackHost ? $this->buildHostPayload($host) : null,
                'action' => 'store',
                'api_calls' => $hostStats['api_calls'],
                'token_usage_month' => $hostStats['token_usage_month'],
                'versions' => $versions,
                'quota_hard_fail' => $quotaHardFail,
                'quota_limit_percent' => $quotaLimitPercent,
                'quota_week_partition' => $quotaWeekPartition,
                'cdx_silent' => $cdxSilent,
            ];

            if ($canonicalPayload) {
                $comparison = Timestamp::compare($incomingLastRefresh, $canonicalLastRefresh);
                $matchesCanonical = $providedDigest !== null && $canonicalDigest !== null && hash_equals($canonicalDigest, $providedDigest);

                if ($matchesCanonical) {
                    $status = 'valid';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'host' => $trackHost ? $this->buildHostPayload($host) : null,
                        'api_calls' => $hostStats['api_calls'],
                        'token_usage_month' => $hostStats['token_usage_month'],
                        'versions' => $versions,
                        'quota_hard_fail' => $quotaHardFail,
                        'quota_limit_percent' => $quotaLimitPercent,
                        'quota_week_partition' => $quotaWeekPartition,
                        'cdx_silent' => $cdxSilent,
                    ];

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                        $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                    }
                } elseif ($comparison === 1) {
                    // Client claims a newer payload; ask it to upload.
                    $status = 'upload_required';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'host' => $trackHost ? $this->buildHostPayload($host) : null,
                        'api_calls' => $hostStats['api_calls'],
                        'token_usage_month' => $hostStats['token_usage_month'],
                        'action' => 'store',
                        'versions' => $versions,
                        'quota_hard_fail' => $quotaHardFail,
                        'quota_limit_percent' => $quotaLimitPercent,
                        'quota_week_partition' => $quotaWeekPartition,
                        'cdx_silent' => $cdxSilent,
                    ];

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                        $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                    }
                } else {
                    // Always hand back canonical to allow hydration, even if client claims newer.
                    $status = 'outdated';
                    $authArray = $canonicalAuthArray ?? $this->canonicalAuthFromPayload($canonicalPayload);
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'host' => $trackHost ? $this->buildHostPayload($host) : null,
                        'auth' => $authArray,
                        'api_calls' => $hostStats['api_calls'],
                        'token_usage_month' => $hostStats['token_usage_month'],
                        'versions' => $versions,
                        'quota_hard_fail' => $quotaHardFail,
                        'quota_limit_percent' => $quotaLimitPercent,
                        'quota_week_partition' => $quotaWeekPartition,
                        'cdx_silent' => $cdxSilent,
                    ];

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                        $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                    }
                }
            }

            $this->logs->log($logHostId, 'auth.retrieve', [
                'status' => $status,
                'incoming_last_refresh' => $incomingLastRefresh,
                'incoming_digest' => $providedDigest,
                'stored_last_refresh' => $canonicalLastRefresh,
                'stored_digest' => $canonicalDigest,
            ]);

            return $response;
        }

        // store command
        $incomingAuth = $this->extractAuthPayload($payload);
        $incomingLastRefresh = $incomingAuth['last_refresh'] ?? null;
        if (!is_string($incomingLastRefresh) || trim($incomingLastRefresh) === '') {
            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
        }
        $this->assertReasonableLastRefresh($incomingLastRefresh, 'auth.last_refresh');

        $incomingAuth = $this->ensureAuthsFallback($incomingAuth);
        $entries = $this->normalizeAuthEntries($incomingAuth);
        $canonicalizedAuth = $this->canonicalizeAuthPayload($incomingAuth, $entries, $incomingLastRefresh);

        $encodedAuth = json_encode($canonicalizedAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encodedAuth === false) {
            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
        }

        $incomingDigest = $this->calculateDigest($encodedAuth);
        if ($trackHost) {
            $this->digests->rememberDigests($hostId, [$incomingDigest]);
        }

        $comparison = $canonicalLastRefresh !== null ? Timestamp::compare($incomingLastRefresh, $canonicalLastRefresh) : 1;
        $shouldUpdate = !$canonicalPayload || $comparison === 1;
        $status = $shouldUpdate ? 'updated' : ($comparison === -1 ? 'outdated' : 'unchanged');

        if ($shouldUpdate) {
            // Persist normalized entries alongside the raw canonical body so older callers can still rehydrate.
            $payloadRow = $this->payloads->create($incomingLastRefresh, $incomingDigest, $trackHost ? $hostId : null, $entries, $encodedAuth);
            $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
            $canonicalPayload = $payloadRow;
            $canonicalDigest = $incomingDigest;
            $canonicalLastRefresh = $incomingLastRefresh;

            if ($trackHost) {
                $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $incomingDigest);
                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                $host = $this->hosts->findById($hostId) ?? $host;
            }

            $response = [
                'status' => $status,
                'auth' => $canonicalizedAuth,
                'canonical_last_refresh' => $canonicalLastRefresh,
                'canonical_digest' => $canonicalDigest,
                'api_calls' => $hostStats['api_calls'],
                'token_usage_month' => $hostStats['token_usage_month'],
                'versions' => $versions,
                'quota_hard_fail' => $quotaHardFail,
                'quota_limit_percent' => $quotaLimitPercent,
                'quota_week_partition' => $quotaWeekPartition,
                'cdx_silent' => $cdxSilent,
            ];
            if ($trackHost) {
                $response['host'] = $this->buildHostPayload($host);
            }

        } else {
            $host = $trackHost ? ($this->hosts->findById($hostId) ?? $host) : $host;

            if ($status === 'outdated' && $canonicalPayload) {
                $authArray = $canonicalAuthArray ?? $this->canonicalAuthFromPayload($canonicalPayload);
                $response = [
                    'status' => $status,
                    'auth' => $authArray,
                    'canonical_last_refresh' => $canonicalLastRefresh,
                    'canonical_digest' => $canonicalDigest,
                    'api_calls' => $hostStats['api_calls'],
                    'token_usage_month' => $hostStats['token_usage_month'],
                    'versions' => $versions,
                    'quota_hard_fail' => $quotaHardFail,
                    'quota_limit_percent' => $quotaLimitPercent,
                    'quota_week_partition' => $quotaWeekPartition,
                    'cdx_silent' => $cdxSilent,
                ];
                if ($trackHost) {
                    $response['host'] = $this->buildHostPayload($host);
                }
            } else {
                $response = [
                    'status' => $status,
                    'canonical_last_refresh' => $canonicalLastRefresh,
                    'canonical_digest' => $canonicalDigest,
                    'api_calls' => $hostStats['api_calls'],
                    'token_usage_month' => $hostStats['token_usage_month'],
                    'versions' => $versions,
                    'quota_hard_fail' => $quotaHardFail,
                    'quota_limit_percent' => $quotaLimitPercent,
                    'quota_week_partition' => $quotaWeekPartition,
                    'cdx_silent' => $cdxSilent,
                ];
            }

            if ($trackHost && $canonicalPayload) {
                $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest ?? $incomingDigest);
                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh ?? $incomingLastRefresh, $canonicalDigest ?? $incomingDigest);
            }
        }

        if ($trackHost) {
            $response['host'] = $response['host'] ?? $this->buildHostPayload($host);
        }

        $this->logs->log($logHostId, 'auth.store', [
            'status' => $status,
            'incoming_last_refresh' => $incomingLastRefresh,
            'incoming_digest' => $incomingDigest,
            'stored_last_refresh' => $canonicalLastRefresh,
            'stored_digest' => $canonicalDigest,
            'client_version' => $normalizedClientVersion,
        ]);

        $validation = null;
        $runnerApplied = false;
        if ($this->runnerVerifier !== null && !$skipRunner) {
            $authToValidate = null;
            if ($canonicalPayload) {
                $authToValidate = $canonicalAuthArray ?? $this->canonicalAuthFromPayload($canonicalPayload);
            } elseif ($canonicalizedAuth !== null) {
                $authToValidate = $canonicalizedAuth;
            }

            if ($authToValidate !== null) {
                $validation = $this->runnerVerifier->verify($authToValidate);
                $this->logs->log($logHostId, 'auth.validate', [
                    'status' => $validation['status'] ?? null,
                    'reason' => $validation['reason'] ?? null,
                    'latency_ms' => $validation['latency_ms'] ?? null,
                ]);

                if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
                    try {
                        $runnerAuth = $validation['updated_auth'];
                        $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                        if (!is_string($runnerLastRefresh) || trim($runnerLastRefresh) === '') {
                            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
                        }
                        $this->assertReasonableLastRefresh($runnerLastRefresh, 'auth.last_refresh');
                        $runnerAuth = $this->ensureAuthsFallback($runnerAuth);
                        $runnerEntries = $this->normalizeAuthEntries($runnerAuth);
                        $runnerCanonical = $this->canonicalizeAuthPayload($runnerAuth, $runnerEntries, $runnerLastRefresh);
                        $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                        if ($runnerEncoded === false) {
                            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
                        }
                        $runnerDigest = $this->calculateDigest($runnerEncoded);
                        $comparisonRunner = $canonicalLastRefresh !== null ? Timestamp::compare($runnerLastRefresh, $canonicalLastRefresh) : 1;
                        $runnerShouldUpdate = $canonicalPayload === null
                            || $comparisonRunner === 1
                            || ($comparisonRunner === 0 && $runnerDigest !== $canonicalDigest);

                        if ($runnerShouldUpdate) {
                            $payloadRow = $this->payloads->create($runnerLastRefresh, $runnerDigest, $trackHost ? $hostId : null, $runnerEntries, $runnerEncoded);
                            $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
                            $canonicalPayload = $payloadRow;
                            $canonicalDigest = $runnerDigest;
                            $canonicalLastRefresh = $runnerLastRefresh;

                            if ($trackHost) {
                                $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $runnerDigest);
                                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                                $host = $this->hosts->findById($hostId) ?? $host;
                            }

                            $response = [
                                'status' => 'updated',
                                'auth' => $this->canonicalAuthFromPayload($canonicalPayload),
                                'canonical_last_refresh' => $canonicalLastRefresh,
                                'canonical_digest' => $canonicalDigest,
                                'api_calls' => (int) ($host['api_calls'] ?? 0),
                                'versions' => $versions,
                                'quota_hard_fail' => $quotaHardFail,
                                'quota_limit_percent' => $quotaLimitPercent,
                                'quota_week_partition' => $quotaWeekPartition,
                            ];
                            if ($trackHost) {
                                $response['host'] = $this->buildHostPayload($host);
                            }
                            $runnerApplied = true;
                            $this->logs->log($logHostId, 'auth.runner_store', [
                                'status' => 'applied',
                                'incoming_last_refresh' => $runnerLastRefresh,
                                'incoming_digest' => $runnerDigest,
                            ]);
                        } else {
                            $this->logs->log($logHostId, 'auth.runner_store', [
                                'status' => 'skipped',
                                'reason' => 'runner auth not newer or identical',
                                'incoming_last_refresh' => $runnerLastRefresh,
                                'incoming_digest' => $runnerDigest,
                                'stored_last_refresh' => $canonicalLastRefresh,
                                'stored_digest' => $canonicalDigest,
                            ]);
                        }
                    } catch (\Throwable $exception) {
                        $this->logs->log($logHostId, 'auth.runner_store', [
                            'status' => 'failed',
                            'reason' => $exception->getMessage(),
                        ]);
                    }
                }
            }
        }

        if ($validation !== null) {
            $this->recordRunnerOutcome($validation, (bool) ($validation['reachable'] ?? true), 'store');
            $response['validation'] = $validation;
        }
        $response['runner_applied'] = $runnerApplied;

        return $response;
    }

    /**
     * Periodic preflight invoked on the first API request after the interval (8 hours).
     * Forces a client version refresh and runs the auth runner once with a force flag.
     */
    public function runDailyPreflight(?array $hostContext = null): void
    {
        $now = time();
        $bootChanged = $this->recordCurrentBootId();
        $lastPreflightRaw = $this->versions->get('daily_preflight') ?? '';
        $lastPreflightTs = $this->parseTimestamp(is_string($lastPreflightRaw) ? $lastPreflightRaw : null);
        $intervalElapsed = $lastPreflightTs === null
            || ($now - $lastPreflightTs) >= $this->runnerPreflightIntervalSeconds
            || $lastPreflightTs > ($now + self::MAX_FUTURE_SKEW_SECONDS);
        $needsVersionRefresh = $bootChanged || $intervalElapsed;

        if ($needsVersionRefresh) {
            // Always refresh the cached GitHub client version on the first request of the interval or boot.
            $this->availableClientVersion(true);
        }

        $shouldRunRunner = false;
        $runnerReason = 'scheduled_preflight';
        if ($bootChanged || $intervalElapsed) {
            $shouldRunRunner = true;
        } elseif ($this->runnerVerifier !== null) {
            // If the runner is in a failed state, allow recovery attempts based on backoff/boot/state.
            [$shouldRun, $recoveryReason] = $this->shouldTriggerRunnerRecovery();
            if ($shouldRun) {
                $shouldRunRunner = true;
                if (is_string($recoveryReason) && $recoveryReason !== '') {
                    $runnerReason = $recoveryReason;
                } else {
                    $runnerReason = 'fail_recovery';
                }
            }
        }

        // Opportunistically run the auth runner when warranted.
        if ($shouldRunRunner && $this->runnerVerifier !== null) {
            $canonicalPayload = $this->resolveCanonicalPayload();
            if ($canonicalPayload !== null) {
                $runnerHost = $this->resolveRunnerHost($hostContext, $canonicalPayload);
                if ($runnerHost !== null) {
                    $versions = $this->versionSnapshot();
                    [$canonicalPayload] = $this->runnerDailyCheck(
                        $canonicalPayload,
                        $runnerHost,
                        $versions,
                        true,
                        $runnerReason
                    );
                }
            }
        }

        $this->versions->set('daily_preflight', gmdate(DATE_ATOM));
    }

    /**
     * Run the runner against the current canonical auth (daily or manual).
     *
     * @param bool $forceRun When true, bypass the once-per-day guard (used for manual admin trigger).
     * @param string $trigger Label for log records.
     *
     * @return array{0: ?array, 1: ?string, 2: ?string} Updated canonical payload, digest, last_refresh
     */
    private function runnerDailyCheck(?array $canonicalPayload, array $host, array $versions, bool $forceRun = false, string $trigger = 'daily_preflight'): array
    {
        if ($canonicalPayload === null || $this->runnerVerifier === null) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        $lastCheck = $this->versions->get('runner_last_check') ?? '';
        $lastFailure = $this->versions->get('runner_last_fail') ?? '';
        $now = time();
        $lastCheckTs = $this->parseTimestamp(is_string($lastCheck) ? $lastCheck : null);
        $runnerFailing = $this->isRunnerFailing();

        if (
            !$forceRun
            && $lastCheckTs !== null
            && ($now - $lastCheckTs) < $this->runnerPreflightIntervalSeconds
        ) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        if (
            !$forceRun
            && $runnerFailing
            && $lastFailure !== ''
            && ($lastFailureTs = strtotime($lastFailure)) !== false
            && ($now - $lastFailureTs) < self::RUNNER_FAILURE_BACKOFF_SECONDS
        ) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh] = $this->runRunnerValidationAttempt(
            $canonicalPayload,
            $host,
            $versions,
            $trigger
        );

        return [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh];
    }

    /**
     * Run the runner once and apply any returned auth updates.
     *
     * @return array{0: ?array, 1: ?string, 2: ?string, 3: ?array|null}
     */
    private function runRunnerValidationAttempt(array $canonicalPayload, array $host, array $versions, string $trigger): array
    {
        $validatedCanonical = $this->validateCanonicalPayload($canonicalPayload);
        if ($validatedCanonical === null) {
            return [null, null, null, null];
        }

        $canonicalAuth = $validatedCanonical['auth'];
        $currentDigest = $validatedCanonical['digest'];
        $currentLastRefresh = $validatedCanonical['last_refresh'];

        $hostId = (int) ($host['id'] ?? 0);
        $trackHost = $hostId > 0;
        $logHostId = $trackHost ? $hostId : null;
        $runnerReachable = false;
        $validation = null;
        try {
            $validation = $this->runnerVerifier->verify($canonicalAuth, null, null, $host);
            $runnerReachable = (bool) ($validation['reachable'] ?? false);
            $this->logs->log($logHostId, 'auth.validate', [
                'status' => $validation['status'] ?? null,
                'reason' => $validation['reason'] ?? null,
                'latency_ms' => $validation['latency_ms'] ?? null,
                'trigger' => $trigger,
            ]);

            if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
                $runnerAuth = $validation['updated_auth'];
                $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                $this->assertReasonableLastRefresh((string) $runnerLastRefresh, 'auth.last_refresh');
                $runnerAuth = $this->ensureAuthsFallback($runnerAuth);
                $runnerEntries = $this->normalizeAuthEntries($runnerAuth);
                $runnerCanonical = $this->canonicalizeAuthPayload($runnerAuth, $runnerEntries, (string) $runnerLastRefresh);
                $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                if ($runnerEncoded === false) {
                    throw new ValidationException(['auth' => ['Unable to encode runner auth payload']]);
                }
                $runnerDigest = $this->calculateDigest($runnerEncoded);

                $comparison = $currentLastRefresh !== null
                    ? Timestamp::compare((string) $runnerLastRefresh, $currentLastRefresh)
                    : 1;

                $shouldUpdate = $canonicalPayload === null
                    || $comparison === 1
                    || ($comparison === 0 && $runnerDigest !== $currentDigest);

                if ($shouldUpdate) {
                    $payloadRow = $this->payloads->create((string) $runnerLastRefresh, $runnerDigest, $trackHost ? $hostId : null, $runnerEntries, $runnerEncoded);
                    $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
                    $canonicalPayload = $payloadRow;

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $runnerDigest);
                        $this->hosts->updateSyncState($hostId, (string) $runnerLastRefresh, $runnerDigest);
                    }
                    $this->logs->log($logHostId, 'auth.runner_store', [
                        'status' => 'applied',
                        'trigger' => $trigger,
                        'incoming_last_refresh' => $runnerLastRefresh,
                        'incoming_digest' => $runnerDigest,
                    ]);
                } else {
                    $this->logs->log($logHostId, 'auth.runner_store', [
                        'status' => 'skipped',
                        'trigger' => $trigger,
                        'reason' => 'runner auth not newer or identical',
                    ]);
                }
            }
        } catch (\Throwable $exception) {
            $this->logs->log($logHostId, 'auth.runner_store', [
                'status' => 'failed',
                'trigger' => $trigger,
                'reason' => $exception->getMessage(),
            ]);
        } finally {
            $this->recordRunnerOutcome($validation ?? ['status' => 'fail'], $runnerReachable, $trigger);
        }

        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;
        return [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh, $validation];
    }

    /**
     * When the runner is failing, decide if we should block the request to re-validate auth.
     *
     * @return array{0: ?array, 1: ?array, 2: ?string, 3: ?string}
     */
    private function enforceRunnerValidationOnFailure(?array $canonicalPayload, ?array $canonicalAuthArray, array $host, array $versions): array
    {
        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;

        [$shouldRun, $recoveryReason] = $this->shouldTriggerRunnerRecovery();
        if (!$shouldRun || $canonicalPayload === null || $canonicalAuthArray === null) {
            return [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh];
        }

        $runnerHost = $this->resolveRunnerHost($host, $canonicalPayload);
        if ($runnerHost === null) {
            throw new HttpException('No host available for runner validation', 503);
        }

        [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh, $validation] = $this->runRunnerValidationAttempt(
            $canonicalPayload,
            $runnerHost,
            $versions,
            'fail_recovery'
        );

        if ($canonicalPayload !== null) {
            $validated = $this->validateCanonicalPayload($canonicalPayload);
            if ($validated !== null) {
                $canonicalAuthArray = $validated['auth'];
                $canonicalDigest = $validated['digest'];
                $canonicalLastRefresh = $validated['last_refresh'];
            } else {
                $canonicalPayload = null;
                $canonicalAuthArray = null;
                $canonicalDigest = null;
                $canonicalLastRefresh = null;
            }
        } else {
            $canonicalAuthArray = null;
        }

        $runnerStatus = strtolower((string) ($validation['status'] ?? 'fail'));
        if ($runnerStatus !== 'ok') {
            $reasonSuffix = isset($validation['reason']) && is_string($validation['reason']) && $validation['reason'] !== ''
                ? ': ' . $validation['reason']
                : '';
            $hostIdForLog = isset($runnerHost['id']) && is_numeric($runnerHost['id']) ? (int) $runnerHost['id'] : null;
            try {
                $this->logs->log(
                    $hostIdForLog,
                    'auth.runner_store',
                    [
                        'status' => 'fail',
                        'trigger' => 'fail_recovery',
                        'recovery_reason' => $recoveryReason,
                        'reason' => $validation['reason'] ?? null,
                    ]
                );
            } catch (\Throwable) {
                // If logging fails (e.g., missing host FK), continue without blocking.
            }
            // Do not block serving auth when runner is failing; allow upload/serve to proceed.
            return [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh];
        }

        return [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh];
    }

    /**
     * Determine whether a failing runner should be retried on this request.
     *
     * @return array{0: bool, 1: ?string} [shouldRun, reason]
     */
    private function shouldTriggerRunnerRecovery(): array
    {
        $bootChanged = $this->recordCurrentBootId();

        $state = strtolower((string) ($this->versions->get('runner_state') ?? ''));
        if ($state !== 'fail') {
            return [false, null];
        }

        $now = time();
        $lastFailTs = $this->parseTimestamp($this->versions->get('runner_last_fail'));
        $lastOkTs = $this->parseTimestamp($this->versions->get('runner_last_ok'));
        $fifteenMinutesElapsed = $lastFailTs === null || ($now - $lastFailTs) >= self::RUNNER_FAILURE_RETRY_SECONDS;
        $staleOk = $lastOkTs === null || ($now - $lastOkTs) >= self::RUNNER_STALE_OK_SECONDS;

        if ($bootChanged) {
            return [true, 'boot'];
        }
        if ($fifteenMinutesElapsed) {
            return [true, 'fail_backoff'];
        }
        if ($staleOk) {
            return [true, 'stale_ok'];
        }

        return [false, null];
    }

    private function isRunnerFailing(): bool
    {
        return strtolower((string) ($this->versions->get('runner_state') ?? '')) === 'fail';
    }

    private function recordRunnerOutcome(array $validation, bool $reachable, string $trigger): void
    {
        $status = strtolower((string) ($validation['status'] ?? 'fail'));
        $nowIso = gmdate(DATE_ATOM);
        if ($status === 'ok') {
            $this->versions->set('runner_state', 'ok');
            $this->versions->set('runner_last_ok', $nowIso);
        } else {
            $this->versions->set('runner_state', 'fail');
            $this->versions->set('runner_last_fail', $nowIso);
        }

        if ($reachable) {
            $this->versions->set('runner_last_check', $nowIso);
        }
    }

    private function recordCurrentBootId(): bool
    {
        $currentBootId = $this->currentBootId();
        if ($currentBootId === null || $currentBootId === '') {
            return false;
        }

        $stored = $this->versions->get('runner_boot_id');
        if ($stored === $currentBootId) {
            return false;
        }

        $this->versions->set('runner_boot_id', $currentBootId);
        return true;
    }

    private function currentBootId(): ?string
    {
        $bootIdPath = '/proc/sys/kernel/random/boot_id';
        $base = null;
        if (is_readable($bootIdPath)) {
            $value = trim((string) file_get_contents($bootIdPath));
            if ($value !== '') {
                $base = $value;
            }
        }

        $procStart = @filemtime('/proc/1');
        if ($base !== null && $procStart !== false) {
            return $base . '|p1-' . $procStart;
        }

        if ($base !== null) {
            return $base;
        }

        if ($procStart !== false) {
            return 'proc1-' . $procStart;
        }

        $hostname = php_uname('n');
        return $hostname !== '' ? 'host-' . $hostname : null;
    }

    private function parseTimestamp(?string $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        $parsed = strtotime($value);
        return $parsed === false ? null : $parsed;
    }

    private function resolveRunnerHost(?array $hostContext = null, ?array $canonicalPayload = null): ?array
    {
        if ($hostContext !== null && isset($hostContext['id'])) {
            return $hostContext;
        }

        $sourceHostId = isset($canonicalPayload['source_host_id']) ? (int) $canonicalPayload['source_host_id'] : null;
        if ($sourceHostId !== null && $sourceHostId > 0) {
            $sourceHost = $this->hosts->findById($sourceHostId);
            if ($sourceHost !== null) {
                return $sourceHost;
            }
        }

        $hosts = $this->hosts->all();

        return $hosts[0] ?? null;
    }

    public function triggerRunnerRefresh(): array
    {
        if ($this->runnerVerifier === null) {
            throw new HttpException('Runner not configured', 503);
        }

        $canonicalPayload = $this->resolveCanonicalPayload();
        if ($canonicalPayload === null) {
            throw new HttpException('No canonical auth payload available', 404);
        }

        $host = null;
        if (isset($canonicalPayload['source_host_id'])) {
            $host = $this->hosts->findById((int) $canonicalPayload['source_host_id']);
        }
        if ($host === null) {
            $hosts = $this->hosts->all();
            $host = $hosts[0] ?? null;
        }
        if ($host === null) {
            throw new HttpException('No host available to tag runner logs', 404);
        }

        $versions = $this->versionSnapshot();
        $originalDigest = $canonicalPayload['sha256'] ?? null;

        [$updatedPayload, $newDigest, $newLastRefresh] = $this->runnerDailyCheck(
            $canonicalPayload,
            $host,
            $versions,
            true,
            'manual'
        );

        $applied = $newDigest !== null && $newDigest !== $originalDigest;

        return [
            'applied' => $applied,
            'canonical_digest' => $newDigest,
            'canonical_last_refresh' => $newLastRefresh,
            'runner_last_check' => $this->versions->get('runner_last_check'),
            'runner_last_fail' => $this->versions->get('runner_last_fail'),
            'runner_last_ok' => $this->versions->get('runner_last_ok'),
            'runner_state' => $this->versions->get('runner_state'),
            'runner_boot_id' => $this->versions->get('runner_boot_id'),
        ];
    }

    public function deleteHost(array $host): array
    {
        if (!isset($host['id'])) {
            throw new HttpException('Host not found', 404);
        }

        $hostId = (int) $host['id'];
        $fqdn = $host['fqdn'] ?? null;

        $this->logs->log($hostId, 'host.delete', [
            'fqdn' => $fqdn,
            'initiator' => 'host_api',
        ]);

        $this->digests->deleteByHostId($hostId);
        $this->hosts->deleteById($hostId);
        // status report deprecated

        return [
            'deleted' => $fqdn,
        ];
    }

    public function recordHostUser(array $host, ?string $username, ?string $hostname = null): array
    {
        if (!isset($host['id'])) {
            throw new HttpException('Host not found', 404);
        }

        $hostId = (int) $host['id'];
        $normalizedUser = trim((string) ($username ?? ''));
        $normalizedHost = $hostname !== null ? trim((string) $hostname) : null;

        if ($normalizedUser !== '') {
            $safeUser = substr($normalizedUser, 0, 255);
            $safeHost = $normalizedHost !== null && $normalizedHost !== '' ? substr($normalizedHost, 0, 255) : null;
            $this->hostUsers->record($hostId, $safeUser, $safeHost);
            $this->logs->log($hostId, 'host.user', [
                'username' => $safeUser,
                'hostname' => $safeHost,
            ]);
        }

        return $this->hostUsers->listByHost($hostId);
    }

    public function recordTokenUsage(array $host, array $payload, ?string $clientIp = null): array
    {
        if (!isset($host['id'])) {
            throw new HttpException('Host not found', 404);
        }

        $usageRows = $this->normalizeUsagePayloads($payload);
        $hostId = (int) $host['id'];
        $records = [];
        $aggregates = [
            'total' => null,
            'input' => null,
            'output' => null,
            'cached' => null,
            'reasoning' => null,
            'cost' => 0.0,
        ];
        $pricingCache = [];
        $resolvePricing = function (?string $model) use (&$pricingCache): array {
            $resolvedModel = $model !== null && $model !== '' ? $model : $this->pricingService->defaultModel();
            if (!array_key_exists($resolvedModel, $pricingCache)) {
                $pricingCache[$resolvedModel] = $this->pricingService->latestPricing($resolvedModel, false);
            }
            return $pricingCache[$resolvedModel];
        };

        foreach ($usageRows as $idx => $usage) {
            foreach (['total', 'input', 'output', 'cached', 'reasoning'] as $field) {
                if ($usage[$field] !== null) {
                    $aggregates[$field] = ($aggregates[$field] ?? 0) + (int) $usage[$field];
                }
            }

            $pricing = $resolvePricing($usage['model'] ?? null);
            $usageCost = $this->normalizeUsageCost($usage, $pricing);
            if ($usageCost !== null) {
                $aggregates['cost'] = ($aggregates['cost'] ?? 0.0) + $usageCost;
            }
            $usageRows[$idx]['cost'] = $usageCost;
        }

        $encodedPayload = null;
        $payloadWrapper = ['usages' => $usageRows];
        $encoded = json_encode($payloadWrapper, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded !== false) {
            $encodedPayload = $encoded;
        }

        $ingest = $this->tokenUsageIngests->record(
            $hostId,
            count($usageRows),
            $aggregates,
            $aggregates['cost'] ?? null,
            $encodedPayload,
            $clientIp !== null && $clientIp !== '' ? $clientIp : null
        );
        $ingestId = $ingest['id'] ?? null;

        foreach ($usageRows as $usage) {
            $details = array_filter([
                'line' => $usage['line'],
                'total' => $usage['total'],
                'input' => $usage['input'],
                'output' => $usage['output'],
                'cached' => $usage['cached'],
                'reasoning' => $usage['reasoning'],
                'cost' => $usage['cost'],
                'model' => $usage['model'],
                'ingest_id' => $ingestId,
            ], static fn ($value) => $value !== null && $value !== '');

            $this->tokenUsages->record(
                $hostId,
                $usage['total'],
                $usage['input'],
                $usage['output'],
                $usage['cached'],
                $usage['reasoning'],
                $usage['cost'],
                $usage['model'],
                $usage['line'],
                $ingestId
            );
            $this->logs->log($hostId, 'token.usage', $details);

            $records[] = [
                'recorded_at' => gmdate(DATE_ATOM),
                'line' => $usage['line'],
                'total' => $usage['total'],
                'input' => $usage['input'],
                'output' => $usage['output'],
                'cached' => $usage['cached'],
                'reasoning' => $usage['reasoning'],
                'cost' => $usage['cost'],
                'model' => $usage['model'],
            ];
        }

        $response = [
            'host_id' => $hostId,
            'recorded' => count($records),
            'usages' => $records,
            'ingest_id' => $ingestId,
            'cost' => $aggregates['cost'] ?? null,
        ];

        if (count($records) === 1) {
            $response = array_merge($response, $records[0]);
        }

        return $response;
    }

    private function normalizeUsagePayloads(array $payload): array
    {
        $entries = [];

        if (isset($payload['usages']) && is_array($payload['usages'])) {
            foreach ($payload['usages'] as $idx => $usage) {
                if (!is_array($usage)) {
                    continue;
                }
                $entries[] = $this->normalizeUsageEntry($usage, 'usages.' . $idx);
            }
        } else {
            $entries[] = $this->normalizeUsageEntry($payload, 'usage');
        }

        if (!$entries) {
            throw new ValidationException(['line' => ['line or numeric fields are required']]);
        }

        return $entries;
    }

    private function normalizeUsageEntry(array $usage, string $path): array
    {
        $line = '';
        if (array_key_exists('line', $usage) && is_string($usage['line'])) {
            $line = $this->sanitizeUsageLine($usage['line']);
        }

        $total = $this->normalizeUsageInt($usage['total'] ?? null, $path . '.total');
        $input = $this->normalizeUsageInt($usage['input'] ?? null, $path . '.input');
        $output = $this->normalizeUsageInt($usage['output'] ?? null, $path . '.output');
        $cached = $this->normalizeUsageInt($usage['cached'] ?? null, $path . '.cached', true);
        $reasoning = $this->normalizeUsageInt($usage['reasoning'] ?? null, $path . '.reasoning', true);

        $model = null;
        if (isset($usage['model']) && is_string($usage['model'])) {
            $model = trim($usage['model']);
        }

        if ($line === '' && $total === null && $input === null && $output === null && $cached === null && $reasoning === null) {
            throw new ValidationException([
                $path => ['line or at least one numeric field is required'],
            ]);
        }

        return [
            'line' => $line !== '' ? $line : null,
            'total' => $total,
            'input' => $input,
            'output' => $output,
            'cached' => $cached,
            'reasoning' => $reasoning,
            'model' => $model !== '' ? $model : null,
        ];
    }

    private function normalizeUsageCost(array $usage, array $pricing): ?float
    {
        $cost = $this->pricingService->calculateCost($pricing, [
            'input' => $usage['input'] ?? 0,
            'output' => $usage['output'] ?? 0,
            'cached' => $usage['cached'] ?? 0,
        ]);

        $value = (float) $cost;
        if (is_nan($value) || is_infinite($value) || $value < 0) {
            return null;
        }

        return round($value, 6);
    }

    private function versionSnapshot(?array $wrapperMetaOverride = null): array
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

        // Client version comes from either an admin lock or GitHub (cached for 3h). If unavailable, client_version will be null.
        $clientVersion = $this->canonicalVersion($available['version'] ?? null);
        $clientCheckedAt = $available['updated_at'] ?? null;
        $clientSource = $available['source'] ?? null;

        // Wrapper is sourced exclusively from the baked file on the server.
        $wrapperVersion = $this->canonicalVersion($wrapperMeta['version'] ?? null);

        return [
            'client_version' => $clientVersion,
            'client_version_checked_at' => $clientCheckedAt,
            'client_version_source' => $clientSource,
            'wrapper_version' => $wrapperVersion,
            'wrapper_sha256' => $wrapperMeta['sha256'] ?? null,
            'wrapper_url' => $wrapperMeta['url'] ?? null,
            'reported_client_version' => $reported['client_version'],
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
        ];
    }

    public static function normalizeQuotaLimitPercent(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        if (is_string($value)) {
            $value = trim($value);
            if ($value === '') {
                return null;
            }
        }
        if (!is_numeric($value)) {
            return null;
        }
        $number = (int) round((float) $value);
        if ($number < self::MIN_QUOTA_LIMIT_PERCENT) {
            return self::MIN_QUOTA_LIMIT_PERCENT;
        }
        if ($number > self::MAX_QUOTA_LIMIT_PERCENT) {
            return self::MAX_QUOTA_LIMIT_PERCENT;
        }
        return $number;
    }

    public static function normalizeQuotaWeekPartition(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (is_string($value)) {
            $value = trim($value);
            if ($value === '') {
                return null;
            }
            if (strcasecmp($value, 'off') === 0) {
                return self::QUOTA_WEEK_PARTITION_OFF;
            }
        }

        if (is_numeric($value)) {
            $value = (int) round((float) $value);
        }

        $allowed = [
            self::QUOTA_WEEK_PARTITION_OFF,
            self::QUOTA_WEEK_PARTITION_FIVE_DAY,
            self::QUOTA_WEEK_PARTITION_SEVEN_DAY,
        ];

        if (in_array($value, $allowed, true)) {
            return $value;
        }

        return null;
    }

    public static function dailyAllowanceForPartition(int $quotaLimitPercent, int $partitionDays): int
    {
        $limit = $quotaLimitPercent;
        if ($limit < self::MIN_QUOTA_LIMIT_PERCENT) {
            $limit = self::MIN_QUOTA_LIMIT_PERCENT;
        } elseif ($limit > self::MAX_QUOTA_LIMIT_PERCENT) {
            $limit = self::MAX_QUOTA_LIMIT_PERCENT;
        }
        if ($partitionDays !== self::QUOTA_WEEK_PARTITION_FIVE_DAY && $partitionDays !== self::QUOTA_WEEK_PARTITION_SEVEN_DAY) {
            return 0;
        }

        // Match cdx bash rounding: (limit + days/2) / days
        $allowance = (int) floor(($limit + ($partitionDays / 2)) / $partitionDays);
        return max(1, $allowance);
    }

    private function quotaLimitPercent(): int
    {
        $stored = $this->versions->get('quota_limit_percent');
        $normalized = self::normalizeQuotaLimitPercent($stored);
        return $normalized ?? self::DEFAULT_QUOTA_LIMIT_PERCENT;
    }

    private function quotaWeekPartition(): int
    {
        $stored = $this->versions->get('quota_week_partition');
        $normalized = self::normalizeQuotaWeekPartition($stored);
        return $normalized ?? self::DEFAULT_QUOTA_WEEK_PARTITION;
    }

    private function sanitizeUsageLine(string $line): string
    {
        // Strip ANSI escape sequences (CSI + OSC) and control chars, then collapse whitespace.
        $clean = preg_replace('/\x1B\[[0-9;?]*[ -\\/]*[@-~]/', '', $line);
        $clean = preg_replace('/\x1B\][^\x07\x1B]*(\x07|\x1B\\\\)/', '', (string) $clean);
        $clean = preg_replace('/[\x00-\x1F\x7F]/', ' ', (string) $clean);
        $clean = preg_replace('/\\\\{2,}/', '\\\\', (string) $clean);
        $clean = preg_replace('/\\[<\\d+\\w?/', '', (string) $clean);
        $clean = preg_replace('/\s+/', ' ', (string) $clean);
        $clean = trim((string) $clean);
        if ($clean === '') {
            return '';
        }

        $usagePos = stripos($clean, 'token usage:');
        if ($usagePos !== false) {
            $clean = trim(substr($clean, $usagePos));
        }

        // Limit to printable ASCII to avoid stray control glyphs.
        $clean = preg_replace('/[^\x20-\x7E]/', '', $clean);

        // Hard cap to avoid oversized payloads in DB/UI.
        if (strlen($clean) > 1000) {
            $clean = substr($clean, 0, 1000) . '…';
        }

        return $clean;
    }

    private function normalizeUsageInt(mixed $value, string $field, bool $optional = false): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (is_string($value)) {
            $normalized = preg_replace('/[,_\\s]/', '', $value);
            if ($normalized === '') {
                return null;
            }
            if (ctype_digit($normalized)) {
                $value = (int) $normalized;
            } else {
                throw new ValidationException([$field => [$field . ' must be a number (digits, optional commas)']]);
            }
        }

        if (is_int($value)) {
            if ($value < 0) {
                throw new ValidationException([$field => [$field . ' must be non-negative']]);
            }

            return $value;
        }

        if (is_numeric($value)) {
            $intVal = (int) $value;
            if ($intVal < 0) {
                throw new ValidationException([$field => [$field . ' must be non-negative']]);
            }

            return $intVal;
        }

        if ($optional) {
            return null;
        }

        throw new ValidationException([$field => [$field . ' must be an integer']]);
    }

    private function normalizeCommand(mixed $command): string
    {
        if (!is_string($command) || trim($command) === '') {
            return 'retrieve';
        }

        $normalized = strtolower(trim($command));
        if (!in_array($normalized, ['retrieve', 'store'], true)) {
            throw new ValidationException(['command' => ['command must be "retrieve" or "store"']]);
        }

        return $normalized;
    }

    private function extractLastRefresh(array $payload, string $field): string
    {
        if (!array_key_exists($field, $payload) || !is_string($payload[$field])) {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        $value = trim($payload[$field]);
        if ($value === '') {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        return $value;
    }

    private function assertReasonableLastRefresh(string $value, string $field): void
    {
        try {
            $dt = new DateTimeImmutable($value);
        } catch (\Exception) {
            throw new ValidationException([$field => ['must be an RFC3339 timestamp']]);
        }

        $ts = $dt->getTimestamp();
        $now = time();

        if ($ts < self::MIN_LAST_REFRESH_EPOCH) {
            throw new ValidationException([$field => ['timestamp is implausibly old']]);
        }

        if ($ts > ($now + self::MAX_FUTURE_SKEW_SECONDS)) {
            throw new ValidationException([$field => ['timestamp is in the future']]);
        }
    }

    private function extractAuthPayload(array $payload): array
    {
        if (array_key_exists('auth', $payload) && is_array($payload['auth'])) {
            return $payload['auth'];
        }

        if (array_key_exists('last_refresh', $payload)) {
            return $payload;
        }

        throw new ValidationException(['auth' => ['Auth payload is required']]);
    }

    private function ensureAuthsFallback(array $authPayload): array
    {
        $hasAuths = isset($authPayload['auths']) && is_array($authPayload['auths']) && count($authPayload['auths']) > 0;
        if ($hasAuths) {
            return $authPayload;
        }

        $tokenCandidates = [];
        if (isset($authPayload['tokens']) && is_array($authPayload['tokens'])) {
            $tokenCandidates[] = $authPayload['tokens']['access_token'] ?? null;
        }
        if (isset($authPayload['OPENAI_API_KEY'])) {
            $tokenCandidates[] = $authPayload['OPENAI_API_KEY'];
        }

        $chosen = null;
        foreach ($tokenCandidates as $candidate) {
            if (is_string($candidate) && trim($candidate) !== '') {
                $chosen = trim($candidate);
                break;
            }
        }

        if ($chosen === null) {
            return $authPayload;
        }

        $authPayload['auths'] = [
            'api.openai.com' => [
                'token' => $chosen,
                'token_type' => 'bearer',
            ],
        ];

        return $authPayload;
    }

    private function extractDigest(array $payload, bool $required): ?string
    {
        $candidates = [
            $payload['digest'] ?? null,
            $payload['auth_digest'] ?? null,
            $payload['auth_sha'] ?? null,
        ];

        foreach ($candidates as $candidate) {
            $normalized = $this->normalizeDigest($candidate);
            if ($normalized !== null) {
                if (!preg_match('/^[a-f0-9]{64}$/', $normalized)) {
                    throw new ValidationException(['digest' => ['digest must be a 64-character hex sha256 value']]);
                }

                return $normalized;
            }
        }

        if ($required) {
            throw new ValidationException(['digest' => ['digest is required']]);
        }

        return null;
    }

    private function assertInsecureHostWindow(array $host, int $hostId, string $command, bool $trackHost): array
    {
        $enabledUntilRaw = $host['insecure_enabled_until'] ?? null;
        $graceUntilRaw = $host['insecure_grace_until'] ?? null;

        $enabledUntil = null;
        $graceUntil = null;
        try {
            if (is_string($enabledUntilRaw) && trim($enabledUntilRaw) !== '') {
                $enabledUntil = new DateTimeImmutable($enabledUntilRaw);
            }
        } catch (\Exception) {
            $enabledUntil = null;
        }
        try {
            if (is_string($graceUntilRaw) && trim($graceUntilRaw) !== '') {
                $graceUntil = new DateTimeImmutable($graceUntilRaw);
            }
        } catch (\Exception) {
            $graceUntil = null;
        }

        $now = new DateTimeImmutable('now');
        $enabledActive = $enabledUntil !== null && $enabledUntil >= $now;
        $graceActive = $graceUntil !== null && $graceUntil >= $now;

        if ($enabledActive) {
            if ($trackHost) {
                $windowMinutes = $this->resolveInsecureWindowMinutes($host);
                $newUntil = $now->modify(sprintf('+%d minutes', $windowMinutes));
                $this->hosts->updateInsecureWindows($hostId, $newUntil->format(DATE_ATOM), $graceUntilRaw, null);
                $host['insecure_enabled_until'] = $newUntil->format(DATE_ATOM);
            }

            return $host;
        }

        if ($command === 'store' && $graceActive) {
            return $host;
        }

        $this->logs->log($trackHost ? $hostId : null, 'auth.insecure.denied', [
            'command' => $command,
            'enabled_until' => $enabledUntilRaw,
            'grace_until' => $graceUntilRaw,
        ]);

        throw new HttpException('Insecure host API access disabled', 403, [
            'code' => 'insecure_api_disabled',
            'enabled_until' => $enabledUntilRaw,
            'grace_until' => $graceUntilRaw,
        ]);
    }

    private function resolveInsecureWindowMinutes(array $host): int
    {
        $raw = $host['insecure_window_minutes'] ?? null;
        if ($raw === null || $raw === '') {
            return self::DEFAULT_INSECURE_WINDOW_MINUTES;
        }

        $minutes = (int) $raw;
        if ($minutes < self::MIN_INSECURE_WINDOW_MINUTES) {
            return self::MIN_INSECURE_WINDOW_MINUTES;
        }
        if ($minutes > self::MAX_INSECURE_WINDOW_MINUTES) {
            return self::MAX_INSECURE_WINDOW_MINUTES;
        }

        return $minutes;
    }

    private function openInitialInsecureWindow(int $hostId): void
    {
        $initialUntil = gmdate(DATE_ATOM, time() + (self::PROVISIONING_WINDOW_MINUTES * 60));
        $this->hosts->updateInsecureWindows($hostId, $initialUntil, null, self::DEFAULT_INSECURE_WINDOW_MINUTES);
        $this->logs->log($hostId, 'auth.insecure.initial_window', [
            'enabled_until' => $initialUntil,
        ]);
    }

    private function buildHostPayload(array $host, bool $includeApiKey = false): array
    {
        $payload = [
            'fqdn' => $host['fqdn'],
            'status' => $host['status'],
            'last_refresh' => $host['last_refresh'] ?? null,
            'updated_at' => $host['updated_at'] ?? null,
            'client_version' => $host['client_version'] ?? null,
            'wrapper_version' => $host['wrapper_version'] ?? null,
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
            'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
            'secure' => isset($host['secure']) ? (bool) (int) $host['secure'] : true,
            'vip' => isset($host['vip']) ? (bool) (int) $host['vip'] : false,
            'insecure_enabled_until' => $host['insecure_enabled_until'] ?? null,
            'insecure_grace_until' => $host['insecure_grace_until'] ?? null,
            'insecure_window_minutes' => isset($host['insecure_window_minutes']) && $host['insecure_window_minutes'] !== null
                ? (int) $host['insecure_window_minutes']
                : null,
            'force_ipv4' => isset($host['force_ipv4']) ? (bool) (int) $host['force_ipv4'] : false,
            'model_override' => $host['model_override'] ?? null,
            'reasoning_effort_override' => $host['reasoning_effort_override'] ?? null,
        ];

        if ($includeApiKey) {
            $payload['api_key'] = $host['api_key_plain'] ?? null;
        }

        return $payload;
    }

    /**
     * Enforce insecure-host window rules for non-/auth surfaces (e.g. MCP) using the same logic as handleAuth.
     * Returns the (possibly updated) host with refreshed insecure window timestamps.
     */
    public function enforceInsecureWindow(array $host, string $command = 'mcp'): array
    {
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : 0;
        $trackHost = $hostId > 0;

        if (isset($host['secure']) && !(bool) (int) $host['secure']) {
            $host = $this->assertInsecureHostWindow($host, $hostId, $command, $trackHost);
        }

        return $host;
    }

    private function sortRecursive(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }

        $isAssoc = array_keys($value) !== range(0, count($value) - 1);
        if ($isAssoc) {
            ksort($value);
        }

        foreach ($value as $k => $v) {
            $value[$k] = $this->sortRecursive($v);
        }

        return $value;
    }

    private function canonicalizeAuthPayload(array $incomingAuth, array $entries, string $incomingLastRefresh): array
    {
        $normalized = $incomingAuth;
        $normalized['last_refresh'] = $incomingLastRefresh;
        $normalized['auths'] = $this->buildAuthArrayFromEntries($incomingLastRefresh, $entries)['auths'];

        return $normalized;
    }

    private function canonicalAuthFromPayload(array $payload): array
    {
        if (isset($payload['body']) && is_string($payload['body']) && $payload['body'] !== '') {
            $decoded = json_decode($payload['body'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return $this->buildAuthArrayFromPayload($payload);
    }

    public function validateCanonicalPayload(?array $payload): ?array
    {
        if ($payload === null) {
            return null;
        }

        try {
            $auth = $this->canonicalAuthFromPayload($payload);
            $lastRefresh = $auth['last_refresh'] ?? null;
            if (!is_string($lastRefresh) || trim($lastRefresh) === '') {
                throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
            }
            $this->assertReasonableLastRefresh($lastRefresh, 'auth.last_refresh');
            $this->normalizeAuthEntries($auth);

            $encoded = json_encode($auth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false) {
                throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
            }
            $digest = $this->calculateDigest($encoded);
            $storedDigest = $payload['sha256'] ?? null;
            if (is_string($storedDigest) && $storedDigest !== '' && !hash_equals($storedDigest, $digest)) {
                throw new ValidationException(['auth.digest' => ['stored digest mismatch']]);
            }

            return [
                'auth' => $auth,
                'digest' => $digest,
                'last_refresh' => $lastRefresh,
                'encoded' => $encoded,
            ];
        } catch (\Throwable $exception) {
            $this->logs->log(
                isset($payload['source_host_id']) ? (int) $payload['source_host_id'] : null,
                'auth.canonical_invalid',
                [
                    'payload_id' => $payload['id'] ?? null,
                    'reason' => $exception->getMessage(),
                ]
            );

            return null;
        }
    }

    private function normalizeAuthEntries(array $authPayload): array
    {
        // Allow fallback when auths are missing or empty but a tokens-style access token exists.
        if (!isset($authPayload['auths']) || !is_array($authPayload['auths']) || count($authPayload['auths']) === 0) {
            $fallbackToken = null;
            if (isset($authPayload['tokens']['access_token']) && is_string($authPayload['tokens']['access_token'])) {
                $fallbackToken = trim($authPayload['tokens']['access_token']);
            } elseif (isset($authPayload['OPENAI_API_KEY']) && is_string($authPayload['OPENAI_API_KEY'])) {
                $fallbackToken = trim($authPayload['OPENAI_API_KEY']);
            }

            if ($fallbackToken !== null && $fallbackToken !== '') {
                // Default target mirrors Codex endpoints; keeps behavior deterministic.
                $authPayload['auths'] = [
                    'api.openai.com' => [
                        'token' => $fallbackToken,
                    ],
                ];
            } else {
                throw new ValidationException(['auth.auths' => ['auths must be an object of targets']]);
            }
        }

        if ($authPayload['auths'] === [] || count($authPayload['auths']) === 0) {
            throw new ValidationException(['auth.auths' => ['auths must contain at least one entry']]);
        }

        $entries = [];
        foreach ($authPayload['auths'] as $target => $entry) {
            if (!is_string($target) || trim($target) === '') {
                throw new ValidationException(['auth.auths' => ['auths keys must be non-empty strings']]);
            }
            if (!is_array($entry)) {
                throw new ValidationException(['auth.auths.' . $target => ['entry must be an object']]);
            }

            $token = $entry['token'] ?? null;
            if (!is_string($token) || trim($token) === '') {
                throw new ValidationException(['auth.auths.' . $target . '.token' => ['token is required']]);
            }
            $token = trim($token);
            $this->assertTokenQuality($token, $target);

            $tokenType = $entry['token_type'] ?? ($entry['type'] ?? 'bearer');
            $organization = $entry['organization'] ?? ($entry['org'] ?? ($entry['default_organization'] ?? ($entry['default_org'] ?? null)));
            $project = $entry['project'] ?? ($entry['default_project'] ?? null);
            $apiBase = $entry['api_base'] ?? ($entry['base_url'] ?? null);

            $meta = [];
            foreach ($entry as $key => $value) {
                if (in_array($key, ['token', 'token_type', 'type', 'organization', 'org', 'default_organization', 'default_org', 'project', 'default_project', 'api_base', 'base_url'], true)) {
                    continue;
                }
                if (is_scalar($value) || $value === null) {
                    $meta[$key] = $value;
                }
            }

            $entries[] = [
                'target' => trim($target),
                'token' => trim($token),
                'token_type' => is_string($tokenType) && trim($tokenType) !== '' ? trim($tokenType) : 'bearer',
                'organization' => is_string($organization) && trim($organization) !== '' ? trim($organization) : null,
                'project' => is_string($project) && trim($project) !== '' ? trim($project) : null,
                'api_base' => is_string($apiBase) && trim($apiBase) !== '' ? trim($apiBase) : null,
                'meta' => $meta ?: null,
            ];
        }

        return $entries;
    }

    private function buildAuthArrayFromEntries(string $lastRefresh, array $entries): array
    {
        $auths = [];

        foreach ($entries as $entry) {
            $item = ['token' => $entry['token']];
            if (isset($entry['token_type']) && $entry['token_type'] !== null) {
                $item['token_type'] = $entry['token_type'];
            }
            if (isset($entry['organization']) && $entry['organization'] !== null) {
                $item['organization'] = $entry['organization'];
            }
            if (isset($entry['project']) && $entry['project'] !== null) {
                $item['project'] = $entry['project'];
            }
            if (isset($entry['api_base']) && $entry['api_base'] !== null) {
                $item['api_base'] = $entry['api_base'];
            }
            if (!empty($entry['meta']) && is_array($entry['meta'])) {
                foreach ($entry['meta'] as $key => $value) {
                    $item[$key] = $value;
                }
            }

            ksort($item);
            $auths[$entry['target']] = $item;
        }

        ksort($auths);

        return [
            'last_refresh' => $lastRefresh,
            'auths' => $auths,
        ];
    }

    private function buildAuthArrayFromPayload(array $payload): array
    {
        $lastRefresh = $payload['last_refresh'] ?? '';
        $entries = $payload['entries'] ?? [];

        return $this->buildAuthArrayFromEntries($lastRefresh, $entries);
    }

    private function assertTokenQuality(string $token, string $target): void
    {
        $minLength = (int) (Config::get('TOKEN_MIN_LENGTH', 24));
        if ($minLength < 8) {
            $minLength = 8;
        }

        if (preg_match('/\s/', $token)) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token may not contain whitespace or newlines']]);
        }

        if (strlen($token) < $minLength) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ["token too short (min {$minLength} characters)"]]);
        }

        $lower = strtolower($token);
        $placeholders = ['token', 'newer-token', 'placeholder', 'changeme', 'dummy', 'test', 'example', 'example-token'];
        if (in_array($lower, $placeholders, true)) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token appears to be a placeholder value']]);
        }

        if (preg_match('/^(.)\1+$/', $token)) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token is not high-entropy (single repeated character)']]);
        }

        $uniqueChars = count(array_unique(str_split($token)));
        if ($uniqueChars < 6) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token entropy too low (too few unique characters)']]);
        }
    }

    private function resolveCanonicalPayload(): ?array
    {
        $id = $this->versions->get('canonical_payload_id');
        if ($id !== null && ctype_digit((string) $id)) {
            $payload = $this->payloads->findByIdWithEntries((int) $id);
            if ($payload) {
                return $payload;
            }
        }

        return $this->payloads->latest();
    }

    public function canonicalAuthSnapshot(): ?array
    {
        $payload = $this->resolveCanonicalPayload();
        if ($payload === null) {
            return null;
        }

        return $this->canonicalAuthFromPayload($payload);
    }

    public function hasCanonicalAuth(): bool
    {
        return $this->resolveCanonicalPayload() !== null;
    }

    public function latestReportedVersions(): array
    {
        $hosts = $this->hosts->all();

        $latestClient = null;

        foreach ($hosts as $host) {
            $client = $host['client_version'] ?? null;
            if (is_string($client) && $client !== '') {
                if ($latestClient === null || $this->isVersionGreater($client, $latestClient)) {
                    $latestClient = $client;
                }
            }
        }

        return [
            'client_version' => $this->canonicalVersion($latestClient),
            'wrapper_version' => null,
        ];
    }

    public function versionSummary(): array
    {
        return $this->versionSnapshot();
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

    public function publishedVersions(): array
    {
        $all = $this->versions->all();

        return [
            'client_version' => $all['client'] ?? null,
            'wrapper_version' => $all['wrapper'] ?? null,
        ];
    }

    private function inactivityWindowDays(): int
    {
        $stored = $this->versions->get('inactivity_window_days');
        $raw = $stored !== null ? $stored : Config::get('INACTIVITY_WINDOW_DAYS', self::DEFAULT_INACTIVITY_WINDOW_DAYS);
        $value = is_numeric($raw) ? (int) $raw : self::DEFAULT_INACTIVITY_WINDOW_DAYS;

        if ($value < 0) {
            return 0;
        }

        return min($value, self::MAX_INACTIVITY_WINDOW_DAYS);
    }

    private function pruneInactiveHosts(): void
    {
        $inactivityDays = $this->inactivityWindowDays();
        $cutoffTimestamp = null;
        $staleHosts = [];

        if ($inactivityDays > 0) {
            $cutoff = (new DateTimeImmutable(sprintf('-%d days', $inactivityDays)));
            $cutoffTimestamp = $cutoff->format(DATE_ATOM);
            $staleHosts = $this->hosts->findInactiveBefore($cutoffTimestamp);
        }
        $provisionCutoff = (new DateTimeImmutable(sprintf('-%d minutes', self::PROVISIONING_WINDOW_MINUTES)))->format(DATE_ATOM);
        $unprovisionedHosts = $this->hosts->findUnprovisionedBefore($provisionCutoff);

        $deleteIds = [];
        $logged = [];

        foreach ($staleHosts as $host) {
            $hostId = (int) $host['id'];
            $deleteIds[] = $hostId;
            $logged[$hostId] = true;
            $this->logs->log($hostId, 'host.pruned', [
                'reason' => 'inactive',
                'cutoff' => $cutoffTimestamp,
                'last_contact' => $host['updated_at'] ?? null,
                'fqdn' => $host['fqdn'],
            ]);
        }

        foreach ($unprovisionedHosts as $host) {
            $hostId = (int) $host['id'];
            if (isset($logged[$hostId])) {
                continue;
            }
            $deleteIds[] = $hostId;
            $this->logs->log($hostId, 'host.pruned', [
                'reason' => 'unprovisioned',
                'cutoff' => $provisionCutoff,
                'created_at' => $host['created_at'] ?? null,
                'fqdn' => $host['fqdn'],
            ]);
        }

        if ($deleteIds) {
            $this->hosts->deleteByIds(array_values(array_unique($deleteIds)));
        }
    }

    public function pruneStaleHosts(): void
    {
        $this->pruneInactiveHosts();
    }

    /**
     * @return array{0:string,1:?string}
     */
    private function normalizeClientVersion(?string $clientVersion): string
    {
        $normalized = $this->canonicalVersion(is_string($clientVersion) ? $clientVersion : '');
        if ($normalized === null || $normalized === '') {
            $normalized = 'unknown';
        }

        return $normalized;
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
        $normalized = trim($value);
        $normalized = preg_replace('/^(codex-cli|codex|rust-)/i', '', $normalized) ?? $normalized;
        $normalized = ltrim($normalized, 'vV');

        return $normalized;
    }

    private function canonicalVersion(?string $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = $this->normalizeVersionString($value);

        return $normalized === '' ? null : $normalized;
    }

    private function normalizeDigest(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $value = strtolower(trim($value));

        return $value === '' ? null : $value;
    }

    private function calculateDigest(?string $authJson): ?string
    {
        if ($authJson === null || $authJson === '') {
            return null;
        }

        return hash('sha256', $authJson);
    }

    private function throttleAuthFailures(?string $ip, string $reason): void
    {
        if ($this->rateLimiter === null || $ip === null || $ip === '') {
            return;
        }

        $limit = (int) (Config::get('RATE_LIMIT_AUTH_FAIL_COUNT', self::AUTH_FAIL_LIMIT));
        $window = (int) (Config::get('RATE_LIMIT_AUTH_FAIL_WINDOW', self::AUTH_FAIL_WINDOW_SECONDS));
        $block = (int) (Config::get('RATE_LIMIT_AUTH_FAIL_BLOCK', self::AUTH_FAIL_BLOCK_SECONDS));

        $limit = $limit > 0 ? $limit : self::AUTH_FAIL_LIMIT;
        $window = $window > 0 ? $window : self::AUTH_FAIL_WINDOW_SECONDS;
        $blockSeconds = $block > 0 ? $block : self::AUTH_FAIL_BLOCK_SECONDS;

        $result = $this->rateLimiter->hit($ip, 'auth-fail', $limit, $window, $blockSeconds);
        if ($result['allowed']) {
            return;
        }

        $this->logs->log(null, 'security.rate_limit', [
            'bucket' => 'auth-fail',
            'ip' => $ip,
            'reason' => $reason,
            'reset_at' => $result['reset_at'],
        ]);

        throw new HttpException('Too many failed authentication attempts', 429, [
            'reset_at' => $result['reset_at'],
            'bucket' => 'auth-fail',
        ]);
    }

    private function shouldAllowRunnerIpBypass(string $ip): bool
    {
        $enabledRaw = Config::get('AUTH_RUNNER_IP_BYPASS', '0');
        $enabled = in_array(strtolower((string) $enabledRaw), ['1', 'true', 'yes', 'on'], true);
        if (!$enabled) {
            return false;
        }

        $subnetsRaw = Config::get('AUTH_RUNNER_BYPASS_SUBNETS', '');
        $subnets = array_filter(array_map('trim', explode(',', (string) $subnetsRaw)));
        if (!$subnets) {
            return false;
        }

        foreach ($subnets as $subnet) {
            if ($this->ipInCidr($ip, $subnet)) {
                return true;
            }
        }

        return false;
    }

    private function ipInCidr(string $ip, string $cidr): bool
    {
        if (!str_contains($cidr, '/')) {
            return false;
        }

        [$network, $mask] = explode('/', $cidr, 2);
        $maskLength = (int) $mask;

        $ipBin = @inet_pton($ip);
        $netBin = @inet_pton($network);

        if ($ipBin === false || $netBin === false || strlen($ipBin) !== strlen($netBin)) {
            return false;
        }

        $bits = strlen($ipBin) * 8;
        if ($maskLength < 0 || $maskLength > $bits) {
            return false;
        }

        $bytes = intdiv($maskLength, 8);
        $remainder = $maskLength % 8;

        if ($bytes && substr($ipBin, 0, $bytes) !== substr($netBin, 0, $bytes)) {
            return false;
        }

        if ($remainder === 0) {
            return true;
        }

        $maskByte = chr(0xFF << (8 - $remainder) & 0xFF);
        return (ord($ipBin[$bytes]) & ord($maskByte)) === (ord($netBin[$bytes]) & ord($maskByte));
    }
}
