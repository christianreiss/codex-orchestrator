<?php

namespace App\Http\Controllers;

use App\Http\Response;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\ChatGptUsageService;
use App\Services\StartupSyncService;

use function App\Http\extractClientVersion;
use function App\Http\extractSyncAuthCandidate;
use function App\Http\extractSyncAuthFingerprint;
use function App\Http\extractSyncHostUserInput;
use function App\Http\extractWrapperVersion;
use function App\Http\normalizeBoolean;
use function App\Http\resolveActiveQuotaLaneForHost;
use function App\Http\resolveApiKey;
use function App\Http\resolveBaseUrl;
use function App\Http\resolveClientIp;

class AuthController
{
    public function __construct(
        private AuthService $service,
        private ChatGptUsageService $chatGptUsageService,
        private StartupSyncService $startupSyncService,
        private VersionRepository $versionRepository,
    ) {}

    public function auth(mixed $payload): void
    {
        if ($this->versionRepository->getFlag('api_disabled', false)) {
            Response::json([
                'status' => 'error',
                'message' => 'API disabled by administrator',
            ], 503);
        }

        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp, false, true);
        $clientVersion = extractClientVersion($payload);
        $wrapperVersion = extractWrapperVersion($payload);
        $baseUrl = resolveBaseUrl();

        // Opportunistically refresh ChatGPT usage if stale (respects cooldown inside service).
        $this->chatGptUsageService->fetchLatest(false);

        $result = $this->service->handleAuth(is_array($payload) ? $payload : [], $host, $clientVersion, $wrapperVersion, $baseUrl);
        $chatgptUsage = $this->chatGptUsageService->latestWindowSummary();
        if (is_array($chatgptUsage)) {
            $chatgptUsage['active_quota_lane'] = resolveActiveQuotaLaneForHost($host, $this->versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
        }
        $result['chatgpt_usage'] = $chatgptUsage;

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function deleteAuth(): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $force = isset($_GET['force']) && $_GET['force'] !== '0';

        $host = $this->service->authenticate($apiKey, $clientIp, $force, true);
        $this->service->deleteHost($host);

        Response::json([
            'status' => 'ok',
            'data' => [
                'deleted' => $host['fqdn'],
            ],
        ]);
    }

    public function syncStatus(mixed $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp, false, true);
        $baseUrl = resolveBaseUrl();
        $requestPayload = is_array($payload) ? $payload : [];

        $hostUserInput = extractSyncHostUserInput($requestPayload);
        $users = $this->service->recordHostUser($host, $hostUserInput['username'], $hostUserInput['hostname']);

        $result = $this->startupSyncService->collect($requestPayload, $host, $baseUrl, $apiKey, false);
        $includeAuth = normalizeBoolean($requestPayload['include_auth'] ?? null);
        if ($includeAuth !== false) {
            $authFingerprint = extractSyncAuthFingerprint($requestPayload);
            $clientVersion = extractClientVersion($requestPayload);
            $wrapperVersion = extractWrapperVersion($requestPayload);
            $authResult = $this->service->handleAuth($authFingerprint, $host, $clientVersion, $wrapperVersion, $baseUrl);

            $this->chatGptUsageService->fetchLatest(false);
            $chatgptUsage = $this->chatGptUsageService->latestWindowSummary();
            if (is_array($chatgptUsage)) {
                $chatgptUsage['active_quota_lane'] = resolveActiveQuotaLaneForHost($host, $this->versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
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
    }

    public function syncBootstrap(mixed $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp, false, true);
        $baseUrl = resolveBaseUrl();
        $requestPayload = is_array($payload) ? $payload : [];

        $hostUserInput = extractSyncHostUserInput($requestPayload);
        $users = $this->service->recordHostUser($host, $hostUserInput['username'], $hostUserInput['hostname']);

        $result = $this->startupSyncService->collect($requestPayload, $host, $baseUrl, $apiKey, true);
        $includeAuth = normalizeBoolean($requestPayload['include_auth'] ?? null);
        if ($includeAuth !== false) {
            $authFingerprint = extractSyncAuthFingerprint($requestPayload);
            $clientVersion = extractClientVersion($requestPayload);
            $wrapperVersion = extractWrapperVersion($requestPayload);
            $authResult = $this->service->handleAuth($authFingerprint, $host, $clientVersion, $wrapperVersion, $baseUrl);
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

                $authResult = $this->service->handleAuth($storePayload, $host, $clientVersion, $wrapperVersion, $baseUrl);
                $authStatus = strtolower(trim((string) ($authResult['status'] ?? '')));
                $didStore = true;
            }

            $this->chatGptUsageService->fetchLatest(false);
            $chatgptUsage = $this->chatGptUsageService->latestWindowSummary();
            if (is_array($chatgptUsage)) {
                $chatgptUsage['active_quota_lane'] = resolveActiveQuotaLaneForHost($host, $this->versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
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
    }
}
