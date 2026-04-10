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
use App\Repositories\InsecureAuthRequestRepository;
use App\Repositories\InsecureDomainAllowRepository;
use App\Repositories\LogRepository;
use App\Repositories\McpAccessLogRepository;
use App\Repositories\McpSessionTokenRepository;
use App\Repositories\AdminEventRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Support\CodexVersionPolicy;
use App\Support\ClaudeVersionPolicy;
use App\Support\Engine;
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
    private const TEMPORARY_HOST_TTL_SECONDS = 7200; // 2 hours
    public const MIN_INSECURE_WINDOW_MINUTES = 0;
    public const MAX_INSECURE_WINDOW_MINUTES = 480;
    public const DEFAULT_INSECURE_WINDOW_MINUTES = 10;
    public const MIN_INSECURE_GRACE_MINUTES = 0;
    public const MAX_INSECURE_GRACE_MINUTES = 480;
    public const DEFAULT_INSECURE_GRACE_MINUTES = 60;
    public const DEFAULT_INSECURE_SESSION_MAX_MINUTES = 480;
    public const MAX_INSECURE_SESSION_MAX_MINUTES = 1440;
    public const MIN_QUOTA_LIMIT_PERCENT = 50;
    public const MAX_QUOTA_LIMIT_PERCENT = 100;
    public const DEFAULT_QUOTA_LIMIT_PERCENT = 100;
    public const QUOTA_WEEK_PARTITION_OFF = 0;
    public const QUOTA_WEEK_PARTITION_FIVE_DAY = 5;
    public const QUOTA_WEEK_PARTITION_SEVEN_DAY = 7;
    public const DEFAULT_QUOTA_WEEK_PARTITION = self::QUOTA_WEEK_PARTITION_OFF;
    private const MIN_LAST_REFRESH_EPOCH = 946684800; // 2000-01-01T00:00:00Z
    private const MAX_FUTURE_SKEW_SECONDS = 300; // allow small clock drift
    // Error codes and log events emitted by this service or its delegates (contract: do not remove):
    // 'code' => 'insecure_api_disabled' (via InsecureHostWindowService)
    // insecure_approval_enabled, auth.insecure.pending, Insecure host approval pending
    // auth.insecure.domain_auto_allow
    private const AUTH_FAIL_LIMIT = 20;
    private const AUTH_FAIL_WINDOW_SECONDS = 600;
    private const AUTH_FAIL_BLOCK_SECONDS = 1800;

    private TokenUsageTracker $tokenUsageTracker;
    private ReverseDnsValidator $reverseDnsValidator;
    private InsecureHostWindowService $insecureHostWindowService;
    private RunnerValidationService $runnerValidationService;
    private ClientVersionService $clientVersionService;

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
        private readonly ?InsecureAuthRequestRepository $insecureAuthRequests = null,
        private readonly ?RunnerVerifier $runnerVerifier = null,
        private readonly ?RateLimiter $rateLimiter = null,
        private readonly ?string $installationId = null,
        ?int $runnerPreflightIntervalSeconds = null,
        private readonly ?InsecureDomainAllowRepository $insecureDomainAllows = null,
        private readonly ?McpSessionTokenRepository $mcpSessionTokens = null,
        private readonly ?McpAccessLogRepository $mcpAccessLogs = null,
        private readonly ?AdminEventRepository $adminEvents = null,
        private readonly ?DashboardGraphStatsService $dashboardGraphStats = null,
        ?RunnerValidationService $runnerValidationService = null
    ) {
        $this->tokenUsageTracker = new TokenUsageTracker(
            $tokenUsages,
            $tokenUsageIngests,
            $pricingService,
            $versions,
            $dashboardGraphStats
        );

        $this->reverseDnsValidator = $this->createReverseDnsValidator($versions);

        $this->insecureHostWindowService = new InsecureHostWindowService(
            $hosts,
            $insecureAuthRequests,
            $insecureDomainAllows,
            $logs,
            $versions
        );

        $this->runnerValidationService = $runnerValidationService ?? new RunnerValidationService(
            $hosts,
            $payloads,
            $hostStates,
            $logs,
            $versions,
            $runnerVerifier,
            $runnerPreflightIntervalSeconds
        );

        $this->clientVersionService = new ClientVersionService(
            $hosts,
            $versions,
            $wrapperService,
            $runnerVerifier,
            $installationId
        );
    }

    protected function createReverseDnsValidator(VersionRepository $versions): ReverseDnsValidator
    {
        return new ReverseDnsValidator($versions);
    }

    /**
     * @param string[] $engines Engine identifiers (e.g. ['codex'], ['claude'], ['codex','claude']).
     */
    public function register(string $fqdn, bool $secure = true, ?int $insecureWindowMinutes = null, array $engines = [Engine::DEFAULT]): array
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
            // Update engines if they differ from what was requested.
            $this->hosts->updateEngines((int) $existing['id'], $engines);
            $apiKey = bin2hex(random_bytes(32));
            $host = $this->hosts->rotateApiKey((int) $existing['id'], $apiKey);
            if (!$secure) {
                $this->insecureHostWindowService->openInitialInsecureWindow((int) $existing['id'], $insecureWindowMinutes);
                $host = $this->hosts->findById((int) $existing['id']) ?? $host;
            }
            if ($host !== null) {
                $host['api_key_plain'] = $apiKey;
            } else {
                $existing['api_key_plain'] = $apiKey;
            }
            $this->logs->log((int) $existing['id'], 'register', [
                'result' => 'rotated',
                'engines' => Engine::serializeHostEngines($engines),
            ]);
            $payload = $this->buildHostPayload($host ?? $existing, true);
            return $payload;
        }

        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create($fqdn, $apiKey, $secure, $engines);
        if (!$secure && isset($host['id'])) {
            $this->insecureHostWindowService->openInitialInsecureWindow((int) $host['id'], $insecureWindowMinutes);
            $host = $this->hosts->findById((int) $host['id']) ?? $host;
        }
        $host['api_key_plain'] = $apiKey;
        $this->logs->log((int) $host['id'], 'register', [
            'result' => 'created',
            'engines' => Engine::serializeHostEngines($engines),
        ]);

        $payload = $this->buildHostPayload($host, true);

        return $payload;
    }

    public function authenticate(?string $apiKey, ?string $ip = null, bool $allowIpBypass = false, bool $enforceReverseDns = false): array
    {
        $this->pruneInactiveHosts();

        if ($apiKey === null || $apiKey === '') {
            $this->throttleAuthFailures($ip, 'missing_api_key');
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'missing_api_key',
                'ip' => $ip,
            ]);
            throw new HttpException('API key missing', 401);
        }

        $host = $this->hosts->findByApiKey($apiKey);
        if (!$host) {
            $this->throttleAuthFailures($ip, 'invalid_api_key');
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'invalid_api_key',
                'ip' => $ip,
            ]);
            throw new HttpException('Invalid API key', 401);
        }

        $hostId = (int) $host['id'];

        if (($host['status'] ?? '') !== 'active') {
            $this->logs->log($hostId, 'auth.denied', [
                'reason' => 'host_disabled',
                'fqdn' => $host['fqdn'] ?? null,
                'status' => $host['status'] ?? null,
                'ip' => $ip,
            ]);
            throw new HttpException('Host is disabled', 403);
        }

        $allowsRoaming = isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false;
        $hostSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;

        $insecureWindowActive = false;
        $insecureGraceActive = false;
        if (!$hostSecure) {
            $now = new DateTimeImmutable('now');
            $insecureWindowActive = $this->insecureHostWindowService->isTimestampActive($host['insecure_enabled_until'] ?? null, $now);
            $insecureGraceActive = $this->insecureHostWindowService->isTimestampActive($host['insecure_grace_until'] ?? null, $now);
        }

        $ipAuthorized = true;
        $ipLogReason = 'none';

        $normalizedIp = $this->normalizeIp($ip);
        $reverseDnsRequired = $enforceReverseDns && $this->reverseDnsValidator->isReverseDnsRequired($host);
        if ($reverseDnsRequired && ($normalizedIp === null || $normalizedIp === '')) {
            $this->logs->log($hostId, 'auth.denied', [
                'reason' => 'reverse_dns_mismatch',
                'fqdn' => $host['fqdn'] ?? null,
                'ip' => $ip,
            ]);
            throw new HttpException('Reverse DNS check failed', 403, [
                'code' => 'reverse_dns_mismatch',
            ]);
        }
        if ($normalizedIp !== null && $normalizedIp !== '') {
            if ($reverseDnsRequired) {
                $this->reverseDnsValidator->assertReverseDnsMatch($host, $normalizedIp);
            }
            $storedIp4 = $this->normalizeIp($host['ip4'] ?? null);
            $storedIp6 = $this->normalizeIp($host['ip6'] ?? null);
            $updateHostIp = function (string $ip) use ($hostId): void {
                $family = $this->ipFamily($ip);
                if ($family === 6) {
                    $this->hosts->updateIp6($hostId, $ip);
                } else {
                    $this->hosts->updateIp4($hostId, $ip);
                }
            };

            if ($storedIp4 === null && $storedIp6 === null) {
                $updateHostIp($normalizedIp);
                $this->logs->log($hostId, 'auth.bind_ip', ['ip' => $normalizedIp]);
                $host = $this->hosts->findById($hostId) ?? $host;
                $ipLogReason = 'bound';
            } else {
                $matchesPrimary = $storedIp4 !== null && hash_equals($storedIp4, $normalizedIp);
                $matchesAlt = $storedIp6 !== null && hash_equals($storedIp6, $normalizedIp);

                if ($matchesPrimary || $matchesAlt) {
                    $ipLogReason = $matchesPrimary ? 'match' : 'match_secondary';
                } elseif ($allowsRoaming) {
                    $updateHostIp($normalizedIp);
                    $this->logs->log($hostId, 'auth.roaming_ip', [
                        'previous_ip' => $storedIp4 ?? $storedIp6,
                        'ip' => $normalizedIp,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                    $ipLogReason = 'roaming';
                } elseif (!$hostSecure && ($insecureWindowActive || $insecureGraceActive)) {
                    $updateHostIp($normalizedIp);
                    $this->logs->log($hostId, 'auth.insecure_ip_override', [
                        'previous_ip' => $storedIp4 ?? $storedIp6,
                        'ip' => $normalizedIp,
                        'window' => $insecureWindowActive ? 'enabled' : 'grace',
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                    $ipLogReason = $insecureWindowActive ? 'insecure_window' : 'insecure_grace';
                } elseif ($allowIpBypass) {
                    $updateHostIp($normalizedIp);
                    $this->logs->log($hostId, 'auth.force_ip_override', [
                        'previous_ip' => $storedIp4 ?? $storedIp6,
                        'ip' => $normalizedIp,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                    $ipLogReason = 'force';
                } elseif ($this->shouldAllowRunnerIpBypass($normalizedIp)) {
                    $this->logs->log($hostId, 'auth.runner_ip_bypass', [
                        'expected_ip' => $storedIp4,
                        'expected_ip_alt' => $storedIp6,
                        'ip' => $normalizedIp,
                    ]);
                    $ipLogReason = 'runner_bypass';
                } elseif ($this->shouldBindSecondaryIp($storedIp4, $storedIp6, $normalizedIp)) {
                    $updateHostIp($normalizedIp);
                    $this->logs->log($hostId, 'auth.bind_ip_secondary', [
                        'primary_ip' => $storedIp4 ?? $storedIp6,
                        'ip' => $normalizedIp,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                    $ipLogReason = 'dual_stack';
                } else {
                    $ipAuthorized = false;
                    $ipLogReason = 'mismatch';
                    error_log(sprintf(
                        '[auth] ip authorization=denied host=%s ip4=%s ip6=%s incoming_ip=%s reason=%s',
                        $host['fqdn'] ?? 'unknown',
                        $storedIp4 ?? 'none',
                        $storedIp6 ?? 'none',
                        $normalizedIp,
                        $ipLogReason
                    ));
                    $this->logs->log($hostId, 'auth.denied', [
                        'reason' => 'ip_mismatch',
                        'fqdn' => $host['fqdn'] ?? null,
                        'expected_ip' => $storedIp4,
                        'expected_ip_alt' => $storedIp6,
                        'received_ip' => $normalizedIp,
                    ]);
                    throw new HttpException('API key not allowed from this IP', 403, [
                        'expected_ip' => $storedIp4,
                        'expected_ip_alt' => $storedIp6,
                        'received_ip' => $normalizedIp,
                    ]);
                }
            }
        }

        if ($normalizedIp !== null && $normalizedIp !== '' && $ipAuthorized) {
            error_log(sprintf(
                '[auth] ip authorization=ok host=%s ip=%s reason=%s',
                $host['fqdn'] ?? 'unknown',
                $normalizedIp,
                $ipLogReason
            ));
        }

        $host = $this->refreshTemporaryHostExpiry($hostId, $host);

        return $host;
    }

    /**
     * Lightweight authentication for cron auto-update endpoints.
     */
    public function authenticateForCron(?string $apiKey, ?string $ip = null): array
    {
        if ($apiKey === null || $apiKey === '') {
            $this->throttleAuthFailures($ip, 'missing_api_key');
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'missing_api_key',
                'ip' => $ip,
                'context' => 'cron',
            ]);
            throw new HttpException('API key missing', 401);
        }

        $host = $this->hosts->findByApiKey($apiKey);
        if (!$host) {
            $this->throttleAuthFailures($ip, 'invalid_api_key');
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'invalid_api_key',
                'ip' => $ip,
                'context' => 'cron',
            ]);
            throw new HttpException('Invalid API key', 401);
        }

        return $host;
    }

    public function authenticateMcpCredential(?string $credential, ?string $ip = null): array
    {
        $this->pruneInactiveHosts();

        if ($credential === null || $credential === '') {
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'missing_mcp_credential',
                'ip' => $ip,
            ]);
            throw new HttpException('MCP credential missing', 401);
        }

        if (!str_starts_with($credential, 'mcp_')) {
            return $this->authenticate($credential, $ip, false);
        }

        if ($this->mcpSessionTokens === null) {
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'mcp_token_unsupported',
                'ip' => $ip,
            ]);
            throw new HttpException('MCP credential invalid', 401, [
                'code' => 'invalid_mcp_token',
            ]);
        }

        $this->mcpSessionTokens->deleteExpired(gmdate(DATE_ATOM));
        $tokenRow = $this->mcpSessionTokens->findByToken($credential);
        if ($tokenRow === null) {
            $this->logs->log(null, 'auth.denied', [
                'reason' => 'invalid_mcp_token',
                'ip' => $ip,
            ]);
            throw new HttpException('MCP credential invalid', 401, [
                'code' => 'invalid_mcp_token',
            ]);
        }

        $expiresAt = is_string($tokenRow['expires_at'] ?? null) ? $tokenRow['expires_at'] : null;
        if ($expiresAt === null || Timestamp::compare($expiresAt, gmdate(DATE_ATOM)) < 0) {
            $this->logs->log(isset($tokenRow['host_id']) ? (int) $tokenRow['host_id'] : null, 'auth.denied', [
                'reason' => 'expired_mcp_token',
                'ip' => $ip,
                'expires_at' => $expiresAt,
            ]);
            throw new HttpException('MCP credential expired', 401, [
                'code' => 'expired_mcp_token',
            ]);
        }

        $hostId = isset($tokenRow['host_id']) ? (int) $tokenRow['host_id'] : 0;
        $host = $hostId > 0 ? $this->hosts->findById($hostId) : null;
        if ($host === null) {
            $this->logs->log($hostId > 0 ? $hostId : null, 'auth.denied', [
                'reason' => 'invalid_mcp_token_host',
                'ip' => $ip,
            ]);
            throw new HttpException('MCP credential invalid', 401, [
                'code' => 'invalid_mcp_token',
            ]);
        }

        if (($host['status'] ?? '') !== 'active') {
            $this->logs->log($hostId, 'auth.denied', [
                'reason' => 'host_disabled',
                'fqdn' => $host['fqdn'] ?? null,
                'status' => $host['status'] ?? null,
                'ip' => $ip,
            ]);
            throw new HttpException('Host is disabled', 403);
        }

        if (isset($tokenRow['id']) && is_numeric($tokenRow['id'])) {
            $this->mcpSessionTokens->touch((int) $tokenRow['id']);
        }

        return $host;
    }

    public function handleAuth(array $payload, array $host, ?string $clientVersion, ?string $wrapperVersion = null, ?string $baseUrl = null, bool $skipRunner = false): array
    {
        $engine = isset($payload['engine']) && is_string($payload['engine']) && Engine::isValid(trim($payload['engine']))
            ? trim($payload['engine'])
            : Engine::DEFAULT;
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : 0;
        $logHostId = $hostId > 0 ? $hostId : null;
        $incomingInstallation = isset($payload['installation_id']) && is_string($payload['installation_id'])
            ? trim($payload['installation_id'])
            : '';
        if ($incomingInstallation !== '' && $this->installationId !== null && $this->installationId !== '' && !hash_equals($this->installationId, $incomingInstallation)) {
            $this->logs->log($logHostId, 'auth.denied', [
                'reason' => 'installation_mismatch',
                'fqdn' => $host['fqdn'] ?? null,
                'incoming_installation_id' => $incomingInstallation,
            ]);
            throw new HttpException('Installation ID mismatch', 403, ['code' => 'installation_mismatch']);
        }

        $normalizedClientVersion = $this->clientVersionService->normalizeClientVersion($clientVersion, $engine);
        $normalizedWrapperVersion = $this->clientVersionService->normalizeClientVersion($wrapperVersion, $engine);

        $command = $this->tokenUsageTracker->normalizeCommand($payload['command'] ?? null);
        $sessionStartedAt = null;
        if ($command === 'store') {
            $sessionStartedAt = $this->insecureHostWindowService->parseSessionStartedAt($payload['session_started_at'] ?? null);
        }

        $hostSecure = isset($host['secure']) ? (bool) (int) $host['secure'] : true;
        $hostVip = isset($host['vip']) ? (bool) (int) $host['vip'] : false;
        $trackHost = $hostId > 0;

        if (!$hostSecure && $command !== 'store') {
            $host = $this->insecureHostWindowService->assertInsecureHostWindow($host, $hostId, $command, $trackHost, $sessionStartedAt);
        }

        if ($trackHost) {
            if ($engine === Engine::CLAUDE) {
                $this->hosts->updateClaudeVersions($hostId, $normalizedClientVersion, $normalizedWrapperVersion);
            } else {
                $this->hosts->updateClientVersions($hostId, $normalizedClientVersion, $normalizedWrapperVersion);
            }
            $this->hosts->incrementApiCalls($hostId);
            $host = $this->hosts->findById($hostId) ?? $host;
        }

        $bakedWrapperMeta = null;
        if ($trackHost && $baseUrl !== null && $baseUrl !== '') {
            $bakedWrapperMeta = $this->wrapperService->bakedForHost($host, $baseUrl, null, $engine);
        }

        $monthStart = gmdate('Y-m-01\T00:00:00\Z');
        $monthEnd = gmdate('Y-m-01\T00:00:00\Z', strtotime('+1 month'));
        $hostTokenMonth = $trackHost ? $this->tokenUsages->totalsForHostRange($hostId, $monthStart, $monthEnd) : null;
        $hostStats = [
            'api_calls' => (int) ($host['api_calls'] ?? 0),
            'token_usage_month' => $hostTokenMonth,
        ];

        $versions = $this->buildVersionSnapshotForHost($bakedWrapperMeta, $host, $trackHost, $engine);
        $quotaHardFail = $this->versions->getFlag('quota_hard_fail', true);
        if ($hostVip) {
            $quotaHardFail = false;
        }
        $quotaLimitPercent = $this->clientVersionService->quotaLimitPercent();
        $quotaWeekPartition = $this->clientVersionService->quotaWeekPartition();
        $cdxSilent = $engine === Engine::CLAUDE
            ? ($this->versions->getFlag('clx_silent', false) || $this->versions->getFlag('cdx_silent', false))
            : $this->versions->getFlag('cdx_silent', false);
        $canonicalPayload = $this->runnerValidationService->resolveCanonicalPayload($engine);
        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;
        $canonicalAuthArray = null;

        if ($canonicalPayload !== null) {
            $validated = $this->runnerValidationService->validateCanonicalPayload($canonicalPayload);
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

        // Runner preflight
        if ($this->runnerVerifier !== null && !$skipRunner) {
            [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh] = $this->runnerValidationService->runnerDailyCheck(
                $canonicalPayload,
                $host,
                $versions,
                false,
                'daily_preflight',
                $engine
            );
            if ($canonicalPayload !== null) {
                $validated = $this->runnerValidationService->validateCanonicalPayload($canonicalPayload);
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
            [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh] = $this->runnerValidationService->enforceRunnerValidationOnFailure(
                $canonicalPayload,
                $canonicalAuthArray,
                $host,
                $versions,
                $engine
            );
        }

        // Refresh the version snapshot after runner activity
        $versions = $this->buildVersionSnapshotForHost($bakedWrapperMeta, $host, $trackHost, $engine);

        $recentDigests = $trackHost ? $this->digests->recentDigests($hostId, 3, $engine) : [];
        if ($trackHost && $canonicalDigest !== null && !in_array($canonicalDigest, $recentDigests, true)) {
            $this->digests->rememberDigests($hostId, [$canonicalDigest], 3, $engine);
            $recentDigests = $this->digests->recentDigests($hostId, 3, $engine);
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
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest, $engine);
                        $this->hosts->updateSyncStateForEngine($hostId, $canonicalLastRefresh, $canonicalDigest, $engine);
                    }
                } elseif ($comparison === 1 || $comparison === 0) {
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
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest, $engine);
                        $this->hosts->updateSyncStateForEngine($hostId, $canonicalLastRefresh, $canonicalDigest, $engine);
                    }
                } else {
                    $status = 'outdated';
                    $authArray = $canonicalAuthArray ?? $this->runnerValidationService->canonicalAuthFromPayload($canonicalPayload);
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
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest, $engine);
                        $this->hosts->updateSyncStateForEngine($hostId, $canonicalLastRefresh, $canonicalDigest, $engine);
                    }
                }
            }

            $this->logs->log($logHostId, 'auth.retrieve', [
                'status' => $status,
                'fqdn' => $host['fqdn'] ?? null,
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

        $incomingAuth = $this->runnerValidationService->ensureAuthsFallback($incomingAuth);
        $entries = $this->runnerValidationService->normalizeAuthEntries($incomingAuth);
        $canonicalizedAuth = $this->runnerValidationService->canonicalizeAuthPayload($incomingAuth, $entries, $incomingLastRefresh);

        $encodedAuth = json_encode($canonicalizedAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encodedAuth === false) {
            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
        }

        $incomingDigest = $this->runnerValidationService->calculateDigest($encodedAuth);
        if ($trackHost) {
            $this->digests->rememberDigests($hostId, [$incomingDigest], 3, $engine);
        }

        $comparison = $canonicalLastRefresh !== null ? Timestamp::compare($incomingLastRefresh, $canonicalLastRefresh) : 1;
        $shouldConsiderUpdate = !$canonicalPayload || $comparison === 1 || ($comparison === 0 && $incomingDigest !== $canonicalDigest);

        $candidateAuth = $canonicalizedAuth;
        $candidateEntries = $entries;
        $candidateEncoded = $encodedAuth;
        $candidateDigest = $incomingDigest;
        $candidateLastRefresh = $incomingLastRefresh;

        $validation = null;
        $runnerApplied = false;
        $runnerOutcomeRecorded = false;
        $runnerOk = false;

        if ($shouldConsiderUpdate && !$skipRunner) {
            if ($this->runnerVerifier === null) {
                throw new HttpException('Auth runner required', 503);
            }

            $validation = $this->runnerVerifier->verify($candidateAuth);
            $this->logs->log($logHostId, 'auth.validate', [
                'status' => $validation['status'] ?? null,
                'reason' => $validation['reason'] ?? null,
                'latency_ms' => $validation['latency_ms'] ?? null,
                'trigger' => 'pre_store',
            ]);

            $runnerReachable = (bool) ($validation['reachable'] ?? false);
            $this->runnerValidationService->recordRunnerOutcome($validation, $runnerReachable, 'pre_store');
            $runnerOutcomeRecorded = true;

            if (!$runnerReachable) {
                throw new HttpException('Auth runner unavailable', 503);
            }

            $runnerStatus = strtolower((string) ($validation['status'] ?? 'fail'));
            if ($runnerStatus !== 'ok') {
                $reason = isset($validation['reason']) && is_string($validation['reason']) ? trim($validation['reason']) : '';
                $message = $reason !== '' ? 'runner validation failed: ' . $reason : 'runner validation failed';
                throw new ValidationException(['auth' => [$message]]);
            }
            $runnerOk = true;

            if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
                try {
                    $runnerAuth = $validation['updated_auth'];
                    $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                    if (!is_string($runnerLastRefresh) || trim($runnerLastRefresh) === '') {
                        throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
                    }
                    $this->assertReasonableLastRefresh($runnerLastRefresh, 'auth.last_refresh');
                    $runnerAuth = $this->runnerValidationService->ensureAuthsFallback($runnerAuth);
                    $runnerEntries = $this->runnerValidationService->normalizeAuthEntries($runnerAuth);
                    $runnerCanonical = $this->runnerValidationService->canonicalizeAuthPayload($runnerAuth, $runnerEntries, $runnerLastRefresh);
                    $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                    if ($runnerEncoded === false) {
                        throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
                    }
                    $runnerDigest = $this->runnerValidationService->calculateDigest($runnerEncoded);

                    $runnerComparison = Timestamp::compare($runnerLastRefresh, $incomingLastRefresh);
                    if ($runnerComparison >= 0) {
                        $candidateAuth = $runnerCanonical;
                        $candidateEntries = $runnerEntries;
                        $candidateEncoded = $runnerEncoded;
                        $candidateDigest = $runnerDigest;
                        $candidateLastRefresh = $runnerLastRefresh;
                        $runnerApplied = true;
                        $this->logs->log($logHostId, 'auth.runner_store', [
                            'status' => 'applied',
                            'trigger' => 'pre_store',
                            'incoming_last_refresh' => $runnerLastRefresh,
                            'incoming_digest' => $runnerDigest,
                        ]);
                    } else {
                        $this->logs->log($logHostId, 'auth.runner_store', [
                            'status' => 'skipped',
                            'reason' => 'runner auth older than upload',
                            'incoming_last_refresh' => $runnerLastRefresh,
                            'stored_last_refresh' => $incomingLastRefresh,
                            'trigger' => 'pre_store',
                        ]);
                    }
                } catch (\Throwable $exception) {
                    $this->logs->log($logHostId, 'auth.runner_store', [
                        'status' => 'failed',
                        'reason' => $exception->getMessage(),
                        'trigger' => 'pre_store',
                    ]);
                }
            }
        }

        $comparison = $canonicalLastRefresh !== null ? Timestamp::compare($candidateLastRefresh, $canonicalLastRefresh) : 1;
        $allowEqualDigestUpdate = $runnerOk && $comparison === 0 && $candidateDigest !== $canonicalDigest;
        $shouldUpdate = !$canonicalPayload || $comparison === 1 || $allowEqualDigestUpdate;
        $status = $shouldUpdate ? 'updated' : ($comparison === -1 ? 'outdated' : 'unchanged');

        if ($runnerApplied && !$shouldUpdate) {
            $runnerApplied = false;
        }

        if ($shouldUpdate) {
            $payloadRow = $this->payloads->create(
                $candidateLastRefresh,
                $candidateDigest,
                $trackHost ? $hostId : null,
                $candidateEntries,
                $candidateEncoded,
                $engine
            );
            $this->versions->set($engine === Engine::CLAUDE ? 'canonical_payload_id_claude' : 'canonical_payload_id', (string) $payloadRow['id']);
            $canonicalPayload = $payloadRow;
            $canonicalDigest = $candidateDigest;
            $canonicalLastRefresh = $candidateLastRefresh;

            if ($trackHost) {
                $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $candidateDigest, $engine);
                $this->hosts->updateSyncStateForEngine($hostId, $canonicalLastRefresh, $canonicalDigest, $engine);
                $host = $this->hosts->findById($hostId) ?? $host;
            }

            $response = [
                'status' => $status,
                'auth' => $candidateAuth,
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
                $authArray = $canonicalAuthArray ?? $this->runnerValidationService->canonicalAuthFromPayload($canonicalPayload);
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
                $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest ?? $incomingDigest, $engine);
                $this->hosts->updateSyncStateForEngine($hostId, $canonicalLastRefresh ?? $incomingLastRefresh, $canonicalDigest ?? $incomingDigest, $engine);
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

        if ($validation === null && $this->runnerVerifier !== null && !$skipRunner) {
            $authToValidate = null;
            if ($canonicalPayload) {
                $authToValidate = $canonicalAuthArray ?? $this->runnerValidationService->canonicalAuthFromPayload($canonicalPayload);
            } elseif ($canonicalizedAuth !== null) {
                $authToValidate = $canonicalizedAuth;
            }

            if ($authToValidate !== null) {
                $validation = $this->runnerVerifier->verify($authToValidate);
                $this->logs->log($logHostId, 'auth.validate', [
                    'status' => $validation['status'] ?? null,
                    'reason' => $validation['reason'] ?? null,
                    'latency_ms' => $validation['latency_ms'] ?? null,
                    'trigger' => 'store',
                ]);

                if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
                    try {
                        $runnerAuth = $validation['updated_auth'];
                        $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                        if (!is_string($runnerLastRefresh) || trim($runnerLastRefresh) === '') {
                            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
                        }
                        $this->assertReasonableLastRefresh($runnerLastRefresh, 'auth.last_refresh');
                        $runnerAuth = $this->runnerValidationService->ensureAuthsFallback($runnerAuth);
                        $runnerEntries = $this->runnerValidationService->normalizeAuthEntries($runnerAuth);
                        $runnerCanonical = $this->runnerValidationService->canonicalizeAuthPayload($runnerAuth, $runnerEntries, $runnerLastRefresh);
                        $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                        if ($runnerEncoded === false) {
                            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
                        }
                        $runnerDigest = $this->runnerValidationService->calculateDigest($runnerEncoded);
                        $comparisonRunner = $canonicalLastRefresh !== null ? Timestamp::compare($runnerLastRefresh, $canonicalLastRefresh) : 1;
                        $runnerShouldUpdate = $canonicalPayload === null
                            || $comparisonRunner === 1
                            || ($comparisonRunner === 0 && $runnerDigest !== $canonicalDigest);

                        if ($runnerShouldUpdate) {
                            $payloadRow = $this->payloads->create(
                                $runnerLastRefresh,
                                $runnerDigest,
                                $trackHost ? $hostId : null,
                                $runnerEntries,
                                $runnerEncoded,
                                $engine
                            );
                            $this->versions->set($engine === Engine::CLAUDE ? 'canonical_payload_id_claude' : 'canonical_payload_id', (string) $payloadRow['id']);
                            $canonicalPayload = $payloadRow;
                            $canonicalDigest = $runnerDigest;
                            $canonicalLastRefresh = $runnerLastRefresh;

                            if ($trackHost) {
                                $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $runnerDigest, $engine);
                                $this->hosts->updateSyncStateForEngine($hostId, $canonicalLastRefresh, $canonicalDigest, $engine);
                                $host = $this->hosts->findById($hostId) ?? $host;
                            }

                            $response = [
                                'status' => 'updated',
                                'auth' => $this->runnerValidationService->canonicalAuthFromPayload($canonicalPayload),
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

        if ($validation !== null && !$runnerOutcomeRecorded) {
            $this->runnerValidationService->recordRunnerOutcome($validation, (bool) ($validation['reachable'] ?? true), 'store');
        }
        if ($validation !== null) {
            $response['validation'] = $validation;
        }
        $response['runner_applied'] = $runnerApplied;

        return $response;
    }

    public function runDailyPreflight(?array $hostContext = null): void
    {
        $this->runnerValidationService->runDailyPreflight(
            $hostContext,
            fn (bool $force) => $this->clientVersionService->availableClientVersion($force),
            fn () => $this->clientVersionService->versionSnapshot()
        );
    }

    public function triggerRunnerRefresh(): array
    {
        return $this->runnerValidationService->triggerRunnerRefresh(
            fn () => $this->clientVersionService->versionSnapshot()
        );
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
        return $this->tokenUsageTracker->recordTokenUsage($host, $payload, $clientIp);
    }

    public function buildHostPayload(array $host, bool $includeApiKey = false): array
    {
        $payload = [
            'fqdn' => $host['fqdn'],
            'status' => $host['status'],
            'last_refresh' => $host['last_refresh'] ?? null,
            'claude_last_refresh' => $host['claude_last_refresh'] ?? null,
            'updated_at' => $host['updated_at'] ?? null,
            'expires_at' => $host['expires_at'] ?? null,
            'client_version' => $host['client_version'] ?? null,
            'client_version_override' => $host['client_version_override'] ?? null,
            'wrapper_version' => $host['wrapper_version'] ?? null,
            'agents_document_id_override' => isset($host['agents_document_id_override']) && $host['agents_document_id_override'] !== null
                ? (int) $host['agents_document_id_override']
                : null,
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
            'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
            'secure' => isset($host['secure']) ? (bool) (int) $host['secure'] : true,
            'vip' => isset($host['vip']) ? (bool) (int) $host['vip'] : false,
            'insecure_enabled_until' => $host['insecure_enabled_until'] ?? null,
            'insecure_grace_until' => $host['insecure_grace_until'] ?? null,
            'insecure_window_minutes' => isset($host['insecure_window_minutes']) && $host['insecure_window_minutes'] !== null
                ? (int) $host['insecure_window_minutes']
                : null,
            'lane_preference' => self::normalizeQuotaLane($host['lane_preference'] ?? null),
            'model_override' => $host['model_override'] ?? null,
            'reasoning_effort_override' => $host['reasoning_effort_override'] ?? null,
            'auto_update_override' => isset($host['auto_update_override']) ? ($host['auto_update_override'] === null ? null : (bool) (int) $host['auto_update_override']) : null,
            'last_cron_check' => $host['last_cron_check'] ?? null,
            // Multi-engine support.
            'engines' => $host['engines'] ?? Engine::DEFAULT,
            'engines_list' => Engine::parseHostEngines($host['engines'] ?? null),
            'claude_client_version' => $host['claude_client_version'] ?? null,
            'claude_wrapper_version' => $host['claude_wrapper_version'] ?? null,
            'claude_auth_digest' => $host['claude_auth_digest'] ?? null,
            'claude_model_override' => $host['claude_model_override'] ?? null,
            'claude_reasoning_effort_override' => $host['claude_reasoning_effort_override'] ?? null,
        ];

        if ($includeApiKey) {
            $payload['api_key'] = $host['api_key_plain'] ?? null;
        }

        return $payload;
    }

    public function applyClientVersionOverrideForHost(array $versions, array $host, string $engine = Engine::DEFAULT): array
    {
        return $this->clientVersionService->applyClientVersionOverrideForHost($versions, $host, $engine);
    }

    public function enforceInsecureWindow(array $host, string $command = 'mcp'): array
    {
        return $this->insecureHostWindowService->enforceInsecureWindow($host, $command);
    }

    public function resolveInsecureGraceUntil(?string $enabledUntil, ?int $windowMinutes = null): ?string
    {
        return $this->insecureHostWindowService->resolveInsecureGraceUntil($enabledUntil, $windowMinutes);
    }

    public function validateCanonicalPayload(?array $payload): ?array
    {
        return $this->runnerValidationService->validateCanonicalPayload($payload);
    }

    public function canonicalAuthSnapshot(): ?array
    {
        return $this->runnerValidationService->canonicalAuthSnapshot();
    }

    public function hasCanonicalAuth(): bool
    {
        return $this->runnerValidationService->hasCanonicalAuth();
    }

    public function latestReportedVersions(): array
    {
        return $this->clientVersionService->latestReportedVersions();
    }

    public function versionSummary(string $engine = Engine::DEFAULT): array
    {
        return $this->clientVersionService->versionSummary($engine);
    }

    public function availableClientVersion(bool $forceRefresh = false): array
    {
        return $this->clientVersionService->availableClientVersion($forceRefresh);
    }

    public function pruneStaleHosts(): void
    {
        $this->insecureHostWindowService->pruneExpiredInsecureDomainAllows();
        $this->pruneInactiveHosts();
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

    public static function normalizeQuotaLane(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = strtolower(trim($value));
        if ($normalized === 'normal' || $normalized === 'spark') {
            return $normalized;
        }

        return null;
    }

    // --- Private helpers that remain on AuthService ---

    private function buildVersionSnapshotForHost(?array $bakedWrapperMeta, array $host, bool $trackHost, string $engine = Engine::DEFAULT): array
    {
        $versions = $this->clientVersionService->versionSnapshotForEngine($engine, $bakedWrapperMeta);
        if ($trackHost) {
            $versions = $this->clientVersionService->applyClientVersionOverrideForHost($versions, $host, $engine);
            $override = $host['auto_update_override'] ?? null;
            if ($override !== null) {
                $versions['auto_update_enabled'] = (bool) (int) $override;
            }
        }
        return $versions;
    }

    private function refreshTemporaryHostExpiry(int $hostId, array $host): array
    {
        $expiresAt = $host['expires_at'] ?? null;
        if (!is_string($expiresAt) || trim($expiresAt) === '') {
            return $host;
        }

        $newExpiresAt = gmdate(DATE_ATOM, time() + self::TEMPORARY_HOST_TTL_SECONDS);
        $this->hosts->updateExpiresAt($hostId, $newExpiresAt);

        $host = $this->hosts->findById($hostId) ?? $host;
        $host['expires_at'] = $newExpiresAt;

        return $host;
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

    private function normalizeDigest(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $value = strtolower(trim($value));

        return $value === '' ? null : $value;
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

    private function normalizeIp(?string $ip): ?string
    {
        if ($ip === null) {
            return null;
        }
        $normalized = trim($ip);
        if ($normalized === '') {
            return null;
        }

        $binary = @inet_pton($normalized);
        if ($binary === false) {
            return null;
        }

        if (strlen($binary) === 16) {
            $v4prefix = str_repeat("\x00", 10) . "\xff\xff";
            if (substr($binary, 0, 12) === $v4prefix) {
                $v4 = substr($binary, 12, 4);
                return inet_ntop($v4);
            }
        }

        return inet_ntop($binary);
    }

    private function ipFamily(?string $ip): ?int
    {
        $normalized = $this->normalizeIp($ip);
        if ($normalized === null) {
            return null;
        }

        return str_contains($normalized, ':') ? 6 : 4;
    }

    private function shouldBindSecondaryIp(?string $ip4, ?string $ip6, string $incoming): bool
    {
        $hasIp4 = $ip4 !== null && $ip4 !== '';
        $hasIp6 = $ip6 !== null && $ip6 !== '';
        if (!$hasIp4 && !$hasIp6) {
            return false;
        }
        if ($hasIp4 && $hasIp6) {
            return false;
        }

        $incomingFamily = $this->ipFamily($incoming);
        if ($incomingFamily === null) {
            return false;
        }

        return ($hasIp4 && !$hasIp6 && $incomingFamily === 6)
            || ($hasIp6 && !$hasIp4 && $incomingFamily === 4);
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
        $nowTimestamp = gmdate(DATE_ATOM);
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
        $expiredHosts = $this->hosts->findExpiredBefore($nowTimestamp);

        $deleteIds = [];
        $logged = [];

        foreach ($expiredHosts as $host) {
            $hostId = (int) $host['id'];
            $deleteIds[] = $hostId;
            $logged[$hostId] = true;
            $this->logs->log($hostId, 'host.pruned', [
                'reason' => 'expired',
                'cutoff' => $nowTimestamp,
                'expires_at' => $host['expires_at'] ?? null,
                'fqdn' => $host['fqdn'],
            ]);
        }

        foreach ($staleHosts as $host) {
            $hostId = (int) $host['id'];
            if (isset($logged[$hostId])) {
                continue;
            }
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
            $expiresAt = $host['expires_at'] ?? null;
            if (is_string($expiresAt) && trim($expiresAt) !== '' && Timestamp::compare($expiresAt, $nowTimestamp) > 0) {
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

        $this->purgeRetainedLogs();
    }

    private function purgeRetainedLogs(): void
    {
        if (!$this->versions->getFlag('log_retention_enabled', false)) {
            return;
        }

        $daysLogs = $this->logRetentionDays('log_retention_days_logs', 90);
        $daysMcp = $this->logRetentionDays('log_retention_days_mcp', 90);
        $daysEvents = $this->logRetentionDays('log_retention_days_events', 30);
        $daysGraphStats = $this->logRetentionDays('log_retention_days_graph_stats', 180);

        $this->logs->deleteOlderThan($daysLogs);

        if ($this->mcpAccessLogs !== null) {
            $this->mcpAccessLogs->deleteOlderThan($daysMcp);
        }

        if ($this->adminEvents !== null) {
            $this->adminEvents->deleteOlderThan($daysEvents);
        }

        if ($this->dashboardGraphStats !== null) {
            $this->dashboardGraphStats->deleteOlderThan($daysGraphStats);
        }
    }

    private function logRetentionDays(string $key, int $default): int
    {
        $raw = $this->versions->get($key);
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
