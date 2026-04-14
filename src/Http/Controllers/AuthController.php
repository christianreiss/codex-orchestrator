<?php

namespace App\Http\Controllers;

use App\Http\PayloadHelper;
use App\Http\RequestHelper;
use App\Http\Response;
use App\Http\VersionHelper;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\ChatGptUsageService;
use App\Services\ClaudeUsageService;
use App\Services\StartupSyncService;
use App\Support\Engine;

class AuthController
{
    public function __construct(
        private AuthService $service,
        private ChatGptUsageService $chatGptUsageService,
        private StartupSyncService $startupSyncService,
        private VersionRepository $versionRepository,
        private ?ClaudeUsageService $claudeUsageService = null,
    ) {}

    public function auth(mixed $payload): void
    {
        if ($this->versionRepository->getFlag('api_disabled', false)) {
            Response::json([
                'status' => 'error',
                'message' => 'API disabled by administrator',
            ], 503);
        }

        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();
        $engine = VersionHelper::extractEngine($payload);
        $host = $this->service->authenticate($apiKey, $clientIp, false, true);
        $clientVersion = VersionHelper::extractClientVersion($payload);
        $wrapperVersion = VersionHelper::extractWrapperVersion($payload);
        $baseUrl = RequestHelper::resolveBaseUrl();

        // Inject engine context into the payload so handleAuth can route appropriately.
        $authPayload = is_array($payload) ? $payload : [];
        $authPayload['engine'] = $engine;

        $result = $this->service->handleAuth($authPayload, $host, $clientVersion, $wrapperVersion, $baseUrl);
        $result['engine'] = $engine;
        $this->attachEngineUsage($result, $host, $engine);

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function deleteAuth(): void
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();
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
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp, false, true);
        $baseUrl = RequestHelper::resolveBaseUrl();
        $requestPayload = is_array($payload) ? $payload : [];
        $engine = VersionHelper::extractEngine($requestPayload);

        $hostUserInput = PayloadHelper::extractSyncHostUserInput($requestPayload);
        $users = $this->service->recordHostUser($host, $hostUserInput['username'], $hostUserInput['hostname']);

        $result = $this->startupSyncService->collect($requestPayload, $host, $baseUrl, $apiKey, false, $engine);
        $includeAuth = VersionHelper::normalizeBoolean($requestPayload['include_auth'] ?? null);
        if ($includeAuth !== false) {
            $authFingerprint = PayloadHelper::extractSyncAuthFingerprint($requestPayload);
            if (!is_array($authFingerprint)) {
                $authFingerprint = [];
            }
            $authFingerprint['engine'] = $engine;
            $clientVersion = VersionHelper::extractClientVersion($requestPayload);
            $wrapperVersion = VersionHelper::extractWrapperVersion($requestPayload);
            $authResult = $this->service->handleAuth($authFingerprint, $host, $clientVersion, $wrapperVersion, $baseUrl);

            $this->attachEngineUsage($authResult, $host, $engine);
            $result['auth'] = $authResult;

            $authStatus = strtolower(trim((string) ($authResult['status'] ?? '')));
            if ($authStatus !== 'valid') {
                $result['reasons'][] = 'auth_' . ($authStatus !== '' ? $authStatus : 'unknown');
            }
        }

        $result['reasons'] = array_values(array_unique(array_filter($result['reasons'] ?? [])));
        $result['status'] = $result['reasons'] === [] ? 'ok' : 'update';
        $result['engine'] = $engine;
        $result['host_users'] = $users;

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    public function syncBootstrap(mixed $payload): void
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();
        $host = $this->service->authenticate($apiKey, $clientIp, false, true);
        $baseUrl = RequestHelper::resolveBaseUrl();
        $requestPayload = is_array($payload) ? $payload : [];
        $engine = VersionHelper::extractEngine($requestPayload);

        $hostUserInput = PayloadHelper::extractSyncHostUserInput($requestPayload);
        $users = $this->service->recordHostUser($host, $hostUserInput['username'], $hostUserInput['hostname']);

        $result = $this->startupSyncService->collect($requestPayload, $host, $baseUrl, $apiKey, true, $engine);
        $includeAuth = VersionHelper::normalizeBoolean($requestPayload['include_auth'] ?? null);
        if ($includeAuth !== false) {
            $authFingerprint = PayloadHelper::extractSyncAuthFingerprint($requestPayload);
            if (!is_array($authFingerprint)) {
                $authFingerprint = [];
            }
            $authFingerprint['engine'] = $engine;
            $clientVersion = VersionHelper::extractClientVersion($requestPayload);
            $wrapperVersion = VersionHelper::extractWrapperVersion($requestPayload);
            $authResult = $this->service->handleAuth($authFingerprint, $host, $clientVersion, $wrapperVersion, $baseUrl);
            $authStatus = strtolower(trim((string) ($authResult['status'] ?? '')));
            $authCandidate = PayloadHelper::extractSyncAuthCandidate($requestPayload);
            $didStore = false;

            if (($authStatus === 'missing' || $authStatus === 'upload_required') && is_array($authCandidate)) {
                $storePayload = [
                    'command' => 'store',
                    'engine' => $engine,
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

            $this->attachEngineUsage($authResult, $host, $engine);
            $result['auth'] = $authResult;

            if ($didStore && ($authStatus === 'updated' || $authStatus === 'unchanged')) {
                $result['reasons'][] = 'auth_stored';
            } elseif ($authStatus !== 'valid') {
                $result['reasons'][] = 'auth_' . ($authStatus !== '' ? $authStatus : 'unknown');
            }
        }

        $result['reasons'] = array_values(array_unique(array_filter($result['reasons'] ?? [])));
        $result['status'] = $result['reasons'] === [] ? 'ok' : 'update';
        $result['engine'] = $engine;
        $result['host_users'] = $users;

        Response::json([
            'status' => 'ok',
            'data' => $result,
        ]);
    }

    /**
     * Attach engine-specific usage summary to the result array.
     * Codex hosts get chatgpt_usage; Claude hosts get claude_usage.
     *
     * @param array<string, mixed> $result
     * @param array<string, mixed> $host
     */
    private function attachEngineUsage(array &$result, array $host, string $engine): void
    {
        if ($engine === Engine::CLAUDE) {
            $result['claude_usage'] = $this->fetchClaudeUsage();
        } else {
            $result['chatgpt_usage'] = $this->fetchChatGptUsage($host);
        }
    }

    /**
     * @param array<string, mixed> $host
     */
    private function fetchChatGptUsage(array $host): mixed
    {
        $this->chatGptUsageService->fetchLatest(false);
        $chatgptUsage = $this->chatGptUsageService->latestWindowSummary();
        if (is_array($chatgptUsage)) {
            $chatgptUsage['active_quota_lane'] = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->versionRepository, $chatgptUsage['active_quota_lane'] ?? null);
        }
        return $chatgptUsage;
    }

    private function fetchClaudeUsage(): mixed
    {
        if ($this->claudeUsageService === null) {
            return null;
        }
        return $this->claudeUsageService->latestUsageSummary();
    }
}
