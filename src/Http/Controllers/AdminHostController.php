<?php

namespace App\Http\Controllers;

use App\Http\Response;
use App\Http\VersionHelper;
use App\Repositories\AgentsRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostRepository;
use App\Repositories\InsecureAuthRequestRepository;
use App\Repositories\InsecureDomainAllowRepository;
use App\Repositories\LogRepository;
use App\Services\AdminAuthService;
use App\Services\AgentsService;
use App\Services\AuthService;
use App\Config;
use App\Repositories\InstallTokenRepository;
use App\Services\ClaudeModelService;
use App\Services\ClientConfigService;
use App\Support\ClaudeVersionPolicy;
use App\Support\CodexVersionPolicy;
use App\Support\Engine;
use App\Support\InstallerMode;

class AdminHostController
{
    public function __construct(
        private HostRepository $hostRepository,
        private HostAuthStateRepository $hostStateRepository,
        private AuthPayloadRepository $authPayloadRepository,
        private HostAuthDigestRepository $digestRepository,
        private InsecureAuthRequestRepository $insecureAuthRequestRepository,
        private InsecureDomainAllowRepository $insecureDomainAllowRepository,
        private AgentsRepository $agentsRepository,
        private LogRepository $logRepository,
        private AuthService $service,
        private InstallTokenRepository $installTokenRepository,
        private AgentsService $agentsService,
    ) {}

    public function auth(string $hostId): void
    {
        requireAdminAccess();
        $hostId = (int) $hostId;
        $engine = VersionHelper::extractEngine(null);
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $includeBody = filter_var($_GET['include_body'] ?? null, FILTER_VALIDATE_BOOLEAN);
        $state = $this->hostStateRepository->findByHostId($hostId, $engine);

        $payloadRow = null;
        if ($state && isset($state['payload_id'])) {
            $payloadRow = $this->authPayloadRepository->findByIdWithEntries((int) $state['payload_id'], $engine);
        }
        if ($payloadRow === null) {
            $payloadRow = $this->authPayloadRepository->latest($engine);
        }

        $validated = $payloadRow ? $this->service->validateCanonicalPayload($payloadRow) : null;

        $auth = null;
        if ($includeBody && $validated !== null) {
            $auth = $validated['auth'];
        }

        $engineLastRefresh = $engine === Engine::CLAUDE
            ? ($host['claude_last_refresh'] ?? null)
            : ($host['last_refresh'] ?? null);
        $engineDigest = $engine === Engine::CLAUDE
            ? ($host['claude_auth_digest'] ?? null)
            : ($host['auth_digest'] ?? null);

        $canonicalLastRefresh = $validated['last_refresh']
            ?? ($engineLastRefresh ?? ($state['seen_at'] ?? null));
        $canonicalDigest = $validated['digest']
            ?? ($state['seen_digest'] ?? $engineDigest);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => (int) $host['id'],
                    'fqdn' => $host['fqdn'],
                    'status' => $host['status'],
                    'last_refresh' => $host['last_refresh'] ?? ($state['seen_at'] ?? null),
                    'claude_last_refresh' => $host['claude_last_refresh'] ?? null,
                    'updated_at' => $host['updated_at'] ?? null,
                    'client_version' => $host['client_version'] ?? null,
                    'claude_client_version' => $host['claude_client_version'] ?? null,
                    'wrapper_version' => $host['wrapper_version'] ?? null,
                    'claude_wrapper_version' => $host['claude_wrapper_version'] ?? null,
                    'auth_digest' => $host['auth_digest'] ?? null,
                    'claude_auth_digest' => $host['claude_auth_digest'] ?? null,
                    'engines' => $host['engines'] ?? Engine::DEFAULT,
                    'ip4' => $host['ip4'] ?? null,
                    'ip6' => $host['ip6'] ?? null,
                    'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
                    'secure' => isset($host['secure']) ? (bool) (int) $host['secure'] : true,
                ],
                'engine' => $engine,
                'canonical_last_refresh' => $canonicalLastRefresh,
                'canonical_digest' => $canonicalDigest,
                'recent_digests' => $this->digestRepository->recentDigests($hostId, 3, $engine),
                'auth' => $auth,
                'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
            ],
        ]);
    }

    public function delete(string $hostId): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $this->logRepository->log($hostId, 'admin.host.delete', ['fqdn' => $host['fqdn']]);
        $this->hostRepository->deleteById($hostId);
        $this->digestRepository->deleteByHostId($hostId);

        Response::json([
            'status' => 'ok',
            'data' => ['deleted' => $hostId],
        ]);
    }

    public function clear(string $hostId): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $this->digestRepository->deleteByHostId($hostId);
        $this->hostRepository->clearHostAuth($hostId);
        $this->logRepository->log($hostId, 'admin.host.clear', ['fqdn' => $host['fqdn']]);

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
    }

    public function roaming(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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

        $this->hostRepository->updateAllowRoaming($hostId, $allow);
        $this->logRepository->log($hostId, 'admin.host.roaming', [
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
    }

    public function secure(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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

        $this->hostRepository->updateSecure($hostId, $secure);
        $this->logRepository->log($hostId, 'admin.host.secure', [
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
    }

    public function vip(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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

        $this->hostRepository->updateVip($hostId, $vip);
        $this->logRepository->log($hostId, 'admin.host.vip', [
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
    }

    public function scalingExempt(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $exemptRaw = $payload['scaling_exempt'] ?? null;
        $exempt = normalizeBoolean($exemptRaw);
        if ($exempt === null) {
            Response::json([
                'status' => 'error',
                'message' => 'scaling_exempt must be boolean',
            ], 422);
        }

        $this->hostRepository->updateScalingExempt($hostId, $exempt);
        $this->logRepository->log($hostId, 'admin.host.scaling_exempt', [
            'fqdn' => $host['fqdn'],
            'scaling_exempt' => $exempt,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => (int) $host['id'],
                    'fqdn' => $host['fqdn'],
                    'scaling_exempt' => $exempt,
                ],
            ],
        ]);
    }

    public function autoUpdate(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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

        $this->hostRepository->updateAutoUpdateOverride($hostId, $override);
        $this->logRepository->log($hostId, 'admin.host.auto_update', [
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
    }

    public function insecureEnable(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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
        $graceUntil = $this->service->resolveInsecureGraceUntil($enabledUntil, $minutes);
        $this->hostRepository->updateInsecureWindows($hostId, $enabledUntil, $graceUntil, $minutes);
        $this->logRepository->log($hostId, 'admin.host.insecure_enable', [
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
    }

    public function insecureDisable(string $hostId): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $this->hostRepository->updateInsecureWindows($hostId, null, null);
        $this->logRepository->log($hostId, 'admin.host.insecure_disable', [
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
    }

    public function insecureApprovalPending(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);

        $requests = array_map(function (array $request): array {
            return [
                'id' => (int) ($request['id'] ?? 0),
                'host_id' => (int) ($request['host_id'] ?? 0),
                'fqdn' => is_string($request['fqdn'] ?? null) ? $request['fqdn'] : '',
                'request_ip' => $request['request_ip'] ?? null,
                'requested_at' => $request['requested_at'] ?? null,
                'updated_at' => $request['updated_at'] ?? null,
                'status' => (string) ($request['status'] ?? ''),
            ];
        }, $this->insecureAuthRequestRepository->listPending());

        Response::json([
            'status' => 'ok',
            'data' => [
                'requests' => $requests,
            ],
        ]);
    }

    public function insecureApprovalAllowDomain(string $requestId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $requestId = (int) $requestId;
        $request = $this->insecureAuthRequestRepository->findById($requestId);
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
        $host = $this->hostRepository->findById($hostId);
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
            if (preg_match('/\s/', $normalized) === 1) {
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
        $domainAllow = $this->insecureDomainAllowRepository->upsert($domain, $minutes, $domainEnabledUntil);
        $this->logRepository->log($hostId, 'admin.insecure.domain_allow', [
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
        $graceUntil = $this->service->resolveInsecureGraceUntil($enabledUntil, $minutes);
        $this->hostRepository->updateInsecureWindows($hostId, $enabledUntil, $graceUntil, $minutes);
        $this->logRepository->log($hostId, 'admin.host.insecure_enable', [
            'fqdn' => $host['fqdn'],
            'enabled_until' => $enabledUntil,
            'window_minutes' => $minutes,
            'source' => 'approval_domain',
            'request_id' => $requestId,
        ]);

        $this->insecureAuthRequestRepository->markApproved($requestId);
        $this->logRepository->log($hostId, 'admin.insecure.approval', [
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
    }

    public function insecureApprovalApprove(string $requestId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);

        $requestId = (int) $requestId;
        $request = $this->insecureAuthRequestRepository->findById($requestId);
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
        $host = $this->hostRepository->findById($hostId);
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
        $graceUntil = $this->service->resolveInsecureGraceUntil($enabledUntil, $minutes);
        $this->hostRepository->updateInsecureWindows($hostId, $enabledUntil, $graceUntil, $minutes);
        $this->logRepository->log($hostId, 'admin.host.insecure_enable', [
            'fqdn' => $host['fqdn'],
            'enabled_until' => $enabledUntil,
            'window_minutes' => $minutes,
            'source' => 'approval',
            'request_id' => $requestId,
        ]);

        $this->insecureAuthRequestRepository->markApproved($requestId);
        $this->logRepository->log($hostId, 'admin.insecure.approval', [
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
    }

    public function insecureApprovalDeny(string $requestId): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_ACTIVATE);

        $requestId = (int) $requestId;
        $request = $this->insecureAuthRequestRepository->findById($requestId);
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
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $this->insecureAuthRequestRepository->markDenied($requestId);
        $this->logRepository->log($hostId, 'admin.insecure.denied', [
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
    }

    public function insecureDomainRevoke(string $allowId): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $allowId = (int) $allowId;
        $allow = $this->insecureDomainAllowRepository->findById($allowId);
        if (!$allow) {
            Response::json([
                'status' => 'error',
                'message' => 'Domain allow not found',
            ], 404);
        }

        $this->insecureDomainAllowRepository->markRevoked($allowId);
        $this->logRepository->log(null, 'admin.insecure.domain_revoke', [
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
    }

    public function curlInsecure(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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

        $this->hostRepository->updateCurlInsecure($hostId, $allow);
        $this->logRepository->log($hostId, 'admin.host.curl_insecure', [
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
    }

    public function reverseDns(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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
        $this->hostRepository->updateReverseDnsMode($hostId, $enabled);
        $this->logRepository->log($hostId, 'admin.host.reverse_dns', [
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
    }

    public function model(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $modelRaw = $payload['model_override'] ?? null;
        $reasoningRaw = $payload['reasoning_effort_override'] ?? null;
        $hasClaudeModelOverride = array_key_exists('claude_model_override', $payload);
        $claudeModelRaw = $hasClaudeModelOverride ? $payload['claude_model_override'] : null;
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
        if ($claudeModelRaw !== null && !is_string($claudeModelRaw)) {
            Response::json([
                'status' => 'error',
                'message' => 'claude_model_override must be string or null',
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

        $claudeModelOverride = null;
        if (is_string($claudeModelRaw) && trim($claudeModelRaw) !== '') {
            $candidate = trim($claudeModelRaw);
            if (!in_array($candidate, ClaudeModelService::SUPPORTED_MODELS, true)) {
                Response::json([
                    'status' => 'error',
                    'message' => 'claude_model_override must be one of: ' . implode(', ', ClaudeModelService::SUPPORTED_MODELS),
                ], 422);
            }
            $claudeModelOverride = $candidate;
        }

        $this->hostRepository->updateModelOverrides(
            $hostId,
            $modelOverride,
            $reasoningOverride
        );
        if ($hasClaudeModelOverride) {
            $this->hostRepository->updateClaudeModelOverride($hostId, $claudeModelOverride);
        }
        $logDetails = [
            'fqdn' => $host['fqdn'] ?? null,
            'model_override' => $modelOverride,
            'reasoning_effort_override' => $reasoningOverride,
        ];
        if ($hasClaudeModelOverride) {
            $logDetails['claude_model_override'] = $claudeModelOverride;
        }
        $this->logRepository->log($hostId, 'admin.host.model_overrides', $logDetails);

        $updated = $this->hostRepository->findById($hostId);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => $hostId,
                    'model_override' => $updated['model_override'] ?? null,
                    'reasoning_effort_override' => $updated['reasoning_effort_override'] ?? null,
                    'claude_model_override' => $updated['claude_model_override'] ?? null,
                ],
            ],
        ]);
    }

    public function codexVersion(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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
            $this->hostRepository->updateClientVersionOverride($hostId, null);
        } else {
            $normalized = CodexVersionPolicy::normalize($selection);
            if (!CodexVersionPolicy::isSemanticVersion($normalized)) {
                Response::json([
                    'status' => 'error',
                    'message' => 'selection must be a semantic version like 0.114.0',
                ], 422);
            }
            $effective = CodexVersionPolicy::resolveEffective($normalized, true)['version'];
            $this->hostRepository->updateClientVersionOverride($hostId, $effective);
        }

        $updated = $this->hostRepository->findById($hostId);
        $override = $updated['client_version_override'] ?? null;

        $this->logRepository->log($hostId, 'admin.host.client_version_override', [
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
    }

    public function claudeVersion(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        $selectionRaw = $payload['selection'] ?? ($payload['claude_client_version_override'] ?? null);
        if ($selectionRaw !== null && !is_string($selectionRaw)) {
            Response::json([
                'status' => 'error',
                'message' => 'selection must be one of: global, or a version like 1.2.3',
            ], 422);
        }

        $selection = is_string($selectionRaw) ? trim($selectionRaw) : 'global';
        $selectionLower = strtolower($selection);
        if ($selectionLower === '' || $selectionLower === 'global' || $selectionLower === 'fleet' || $selectionLower === 'default') {
            $this->hostRepository->updateClaudeClientVersionOverride($hostId, null);
        } else {
            $normalized = ClaudeVersionPolicy::normalize($selection);
            if (!ClaudeVersionPolicy::isSemanticVersion($normalized)) {
                Response::json([
                    'status' => 'error',
                    'message' => 'selection must be a semantic version like 1.2.3',
                ], 422);
            }
            $effective = ClaudeVersionPolicy::resolveEffective($normalized, true)['version'];
            $this->hostRepository->updateClaudeClientVersionOverride($hostId, $effective);
        }

        $updated = $this->hostRepository->findById($hostId);
        $override = $updated['claude_client_version_override'] ?? null;

        $this->logRepository->log($hostId, 'admin.host.claude_client_version_override', [
            'fqdn' => $host['fqdn'] ?? null,
            'claude_client_version_override' => $override,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => $hostId,
                    'claude_client_version_override' => $override,
                ],
            ],
        ]);
    }

    public function agentsVersion(string $hostId, array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);
        $hostId = (int) $hostId;
        $host = $this->hostRepository->findById($hostId);
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
            $this->hostRepository->updateAgentsDocumentOverride($hostId, null);
        } else {
            $selectionId = is_numeric($selection) ? (int) $selection : 0;
            if ($selectionId <= 0) {
                Response::json([
                    'status' => 'error',
                    'message' => 'selection must be a valid agents document id',
                ], 422);
            }
            $version = $this->agentsRepository->findById($selectionId);
            if ($version === null) {
                Response::json([
                    'status' => 'error',
                    'message' => 'agents document id not found',
                ], 422);
            }
            $this->hostRepository->updateAgentsDocumentOverride($hostId, $selectionId);
        }

        $updated = $this->hostRepository->findById($hostId);
        $overrideId = $updated['agents_document_id_override'] ?? null;
        $prunedCount = $this->agentsService->pruneBackupsIfNeeded('host_override');

        $this->logRepository->log($hostId, 'admin.host.agents_version_override', [
            'fqdn' => $host['fqdn'] ?? null,
            'agents_document_id_override' => $overrideId,
            'pruned_count' => $prunedCount,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => [
                    'id' => $hostId,
                    'agents_document_id_override' => $overrideId !== null ? (int) $overrideId : null,
                ],
                'pruned_count' => $prunedCount,
            ],
        ]);
    }

    public function register(array $payload): void
    {
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

        // Engine selection — defaults to ['codex'] for backwards compatibility.
        $engines = [Engine::DEFAULT];
        if (array_key_exists('engines', $payload)) {
            $enginesRaw = $payload['engines'];
            if (is_string($enginesRaw)) {
                $enginesRaw = array_map('trim', explode(',', $enginesRaw));
            }
            if (is_array($enginesRaw)) {
                $validated = array_filter($enginesRaw, fn ($e) => is_string($e) && Engine::isValid($e));
                if ($validated === []) {
                    Response::json([
                        'status' => 'error',
                        'message' => 'engines must contain at least one of: ' . implode(', ', Engine::ALL),
                    ], 422);
                }
                $engines = array_values($validated);
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

        $hostPayload = $this->service->register($fqdn, $secure, $durationMinutes, $engines);
        $host = $this->hostRepository->findByFqdn($fqdn);
        if (!$host) {
            Response::json([
                'status' => 'error',
                'message' => 'Host could not be loaded after registration',
            ], 500);
        }

        if ($vip !== null) {
            $this->hostRepository->updateVip((int) $host['id'], $vip);
            $host = $this->hostRepository->findById((int) $host['id']) ?? $host;
            $hostPayload['vip'] = $vip;
        }

        if ($temporary !== null) {
            $expiresAt = null;
            if ($temporary) {
                $expiresAt = gmdate(DATE_ATOM, time() + 7200);
            }
            $this->hostRepository->updateExpiresAt((int) $host['id'], $expiresAt);
            $host = $this->hostRepository->findById((int) $host['id']) ?? $host;
            $hostPayload['expires_at'] = $expiresAt;
        }

        if ($curlInsecure !== null) {
            $this->hostRepository->updateCurlInsecure((int) $host['id'], $curlInsecure);
            $this->logRepository->log((int) $host['id'], 'admin.host.curl_insecure', [
                'fqdn' => $host['fqdn'] ?? null,
                'curl_insecure' => $curlInsecure,
            ]);
            $host = $this->hostRepository->findById((int) $host['id']) ?? $host;
            $hostPayload['curl_insecure'] = $curlInsecure;
        }

        if ($reverseDnsMode !== null) {
            $reverseDnsValue = $reverseDnsMode === 'global' ? null : ($reverseDnsMode === 'enabled');
            $this->hostRepository->updateReverseDnsMode((int) $host['id'], $reverseDnsValue);
            $this->logRepository->log((int) $host['id'], 'admin.host.reverse_dns', [
                'fqdn' => $host['fqdn'] ?? null,
                'reverse_dns_mode' => $reverseDnsMode,
            ]);
            $host = $this->hostRepository->findById((int) $host['id']) ?? $host;
            $hostPayload['reverse_dns_mode'] = $reverseDnsMode;
        }

        $this->installTokenRepository->deleteExpired(gmdate(DATE_ATOM));

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
        $installerMode = InstallerMode::forHostEngines($engines);
        $tokenRow = $this->installTokenRepository->create(
            generateUuid(),
            (int) $host['id'],
            (string) ($hostPayload['api_key'] ?? ($host['api_key_plain'] ?? '')),
            (string) $host['fqdn'],
            $expiresAt,
            $baseUrl,
            $installerMode
        );

        $this->logRepository->log((int) $host['id'], 'admin.install_token.create', [
            'fqdn' => $host['fqdn'],
            'expires_at' => $expiresAt,
            'installer_mode' => $installerMode,
            'token' => substr((string) $tokenRow['token'], 0, 8) . '…',
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'host' => array_merge($hostPayload, ['id' => (int) $host['id']]),
                'installer' => [
                    'token' => $tokenRow['token'],
                    'mode' => $installerMode,
                    'label' => InstallerMode::label($installerMode),
                    'url' => rtrim($baseUrl, '/') . '/install/' . $tokenRow['token'],
                    'command' => installerCommand($baseUrl, $tokenRow['token']),
                    'expires_at' => $expiresAt,
                ],
            ],
        ]);
    }
}
