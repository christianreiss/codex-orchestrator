<?php

declare(strict_types=1);

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Http\Controllers;

use App\Http\Response;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AdminAuthService;
use App\Services\JoplinCacheService;
use App\Services\JoplinService;

class AdminJoplinController
{
    private const VERIFIED_HASH_KEY = 'joplin_verified_config_hash';
    private const VERIFIED_AT_KEY = 'joplin_verified_at';
    private const AUTH_REQUEST_TOKEN_KEY = 'joplin_auth_request_token';
    private const AUTH_REQUEST_STARTED_AT_KEY = 'joplin_auth_request_started_at';

    public function __construct(
        private readonly VersionRepository $versionRepository,
        private readonly LogRepository $logRepository,
        private readonly ?JoplinCacheService $joplinCacheService = null,
    ) {}

    /**
     * GET /admin/joplin/config
     */
    public function getConfig(): void
    {
        requireAdminAccess();

        Response::json(['status' => 'ok', 'data' => $this->readConfigState()]);
    }

    /**
     * POST /admin/joplin/config
     */
    public function postConfig(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $state = $this->readConfigState();
        $enabled = (bool) ($state['enabled'] ?? false);
        $url = (string) ($state['url'] ?? '');
        $token = (string) ($this->versionRepository->get('joplin_api_token') ?? '');
        $interval = (int) ($state['sync_interval_minutes'] ?? 15);
        $configFieldsPresent = array_intersect(['url', 'token', 'sync_interval_minutes'], array_keys($payload));
        $autoDisabled = false;
        $connectionConfigChanged = false;
        $wasEnabled = $enabled;

        if (array_key_exists('enabled', $payload)) {
            $requestedEnabled = normalizeBoolean($payload['enabled']);
            if ($requestedEnabled === null) {
                Response::json(['status' => 'error', 'message' => 'enabled must be boolean'], 422);
            }

            if ($requestedEnabled && $configFieldsPresent !== []) {
                Response::json([
                    'status' => 'error',
                    'message' => 'Save the Joplin configuration before enabling the module',
                ], 422);
            }

            if ($requestedEnabled) {
                $activationState = $this->buildConfigState($enabled, $url, $token, $interval);
                if (!$activationState['can_activate']) {
                    Response::json([
                        'status' => 'error',
                        'message' => $this->activationBlockedMessage((string) $activationState['activation_reason']),
                        'data' => $activationState,
                    ], 422);
                }
            }

            $enabled = $requestedEnabled;
        }

        if (array_key_exists('url', $payload)) {
            $newUrl = $this->normalizeUrl((string) $payload['url']);
            $urlChanged = $newUrl !== $this->normalizeUrl($url);
            $url = $newUrl;
            if ($url !== '' && !preg_match('#^https?://#i', $url)) {
                Response::json(['status' => 'error', 'message' => 'url must be a valid http/https URL'], 422);
            }
            $this->versionRepository->set('joplin_url', $url);
            $connectionConfigChanged = $connectionConfigChanged || $urlChanged;
        }

        if (array_key_exists('token', $payload)) {
            $newToken = trim((string) $payload['token']);
            if ($newToken !== '') {
                $tokenChanged = !hash_equals($token, $newToken);
                $token = $newToken;
                $this->versionRepository->set('joplin_api_token', $token);
                $connectionConfigChanged = $connectionConfigChanged || $tokenChanged;
            }
        }

        if (array_key_exists('sync_interval_minutes', $payload)) {
            $interval = (int) $payload['sync_interval_minutes'];
            if ($interval < 1 || $interval > 1440) {
                Response::json(['status' => 'error', 'message' => 'sync_interval_minutes must be between 1 and 1440'], 422);
            }
            $this->versionRepository->set('joplin_sync_interval_minutes', (string) $interval);
        }

        if ($connectionConfigChanged) {
            $this->clearVerificationState();
            $this->clearAuthRequestState();
            if ($enabled) {
                $enabled = false;
                $autoDisabled = true;
            }
        }

        $initialSync = null;
        if ($enabled && !$wasEnabled) {
            $initialSync = $this->runFullSyncOrFail();
        }

        $this->versionRepository->set('joplin_enabled', $enabled ? '1' : '0');

        $this->logRepository->log(null, 'admin.joplin.config', [
            'fields_updated' => array_keys($payload),
            'connection_config_changed' => $connectionConfigChanged,
            'auto_disabled' => $autoDisabled,
            'enabled' => $enabled,
            'initial_sync' => $initialSync,
        ]);

        $updatedState = $this->buildConfigState($enabled, $url, $token, $interval);
        $updatedState['auto_disabled'] = $autoDisabled;
        if ($initialSync !== null) {
            $updatedState['initial_sync'] = $initialSync;
        }

        Response::json(['status' => 'ok', 'data' => $updatedState]);
    }

    /**
     * POST /admin/joplin/test
     */
    public function postTest(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $state = $this->readConfigState();
        $url = (string) ($state['url'] ?? '');
        $token = (string) ($this->versionRepository->get('joplin_api_token') ?? '');
        $interval = (int) ($state['sync_interval_minutes'] ?? 15);

        $providedUrl = array_key_exists('url', $payload) ? $this->normalizeUrl((string) $payload['url']) : null;
        $providedToken = array_key_exists('token', $payload) ? trim((string) $payload['token']) : null;
        if (($providedUrl !== null && $providedUrl !== '' && $providedUrl !== $this->normalizeUrl($url))
            || ($providedToken !== null && $providedToken !== '' && !hash_equals($token, $providedToken))
            || array_key_exists('sync_interval_minutes', $payload)
            || array_key_exists('enabled', $payload)
        ) {
            Response::json([
                'status' => 'error',
                'message' => 'Save the Joplin configuration before testing the connection',
                'data' => $state,
            ], 422);
        }

        if ($url === '' || $token === '') {
            Response::json(['status' => 'error', 'message' => 'url and token are required'], 422);
        }

        $probe = $this->createJoplinService($url, $token)->testConnection();
        $reachable = (bool) ($probe['reachable'] ?? false);
        $status = $reachable ? 200 : null;

        if ($reachable) {
            $this->versionRepository->set(self::VERIFIED_HASH_KEY, $this->verificationFingerprint($url, $token) ?? '');
            $this->versionRepository->set(self::VERIFIED_AT_KEY, gmdate(DATE_ATOM));
        } else {
            $this->clearVerificationState();
        }

        $updatedState = $this->buildConfigState((bool) ($state['enabled'] ?? false), $url, $token, $interval);
        $updatedState['reachable'] = $reachable;
        $updatedState['status_code'] = $status;
        $updatedState['reason'] = $probe['reason'] ?? null;
        $updatedState['version'] = $probe['version'] ?? null;

        Response::json(['status' => 'ok', 'data' => $updatedState]);
    }

    /**
     * POST /admin/joplin/auth/request
     */
    public function postAuthRequest(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $state = $this->readConfigState();
        $url = (string) ($state['url'] ?? '');
        $providedUrl = array_key_exists('url', $payload) ? $this->normalizeUrl((string) $payload['url']) : null;
        if ($providedUrl !== null && $providedUrl !== '' && $providedUrl !== $this->normalizeUrl($url)) {
            Response::json([
                'status' => 'error',
                'message' => 'Save the Joplin URL before requesting access',
                'data' => $state,
            ], 422);
        }

        if ($url === '') {
            Response::json([
                'status' => 'error',
                'message' => 'Save a Joplin URL before requesting access',
                'data' => $state,
            ], 422);
        }

        $request = $this->createJoplinService($url, '')->requestAccess();
        if (!(bool) ($request['started'] ?? false) || !is_string($request['auth_token'] ?? null) || trim((string) $request['auth_token']) === '') {
            Response::json([
                'status' => 'error',
                'message' => (string) ($request['reason'] ?? 'Could not start the Joplin access request'),
                'data' => $state,
            ], 502);
        }

        $startedAt = gmdate(DATE_ATOM);
        $this->versionRepository->set(self::AUTH_REQUEST_TOKEN_KEY, trim((string) $request['auth_token']));
        $this->versionRepository->set(self::AUTH_REQUEST_STARTED_AT_KEY, $startedAt);

        $updatedState = $this->readConfigState();
        $updatedState['auth_request_pending'] = true;
        $updatedState['auth_request_started_at'] = $startedAt;
        $updatedState['auth_request_status'] = 'waiting';

        $this->logRepository->log(null, 'admin.joplin.auth.request', [
            'url' => $url,
            'started_at' => $startedAt,
        ]);

        Response::json(['status' => 'ok', 'data' => $updatedState]);
    }

    /**
     * POST /admin/joplin/auth/check
     */
    public function postAuthCheck(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $state = $this->readConfigState();
        $url = (string) ($state['url'] ?? '');
        $interval = (int) ($state['sync_interval_minutes'] ?? 15);
        $existingToken = (string) ($this->versionRepository->get('joplin_api_token') ?? '');
        $authRequestToken = trim((string) ($this->versionRepository->get(self::AUTH_REQUEST_TOKEN_KEY) ?? ''));
        $startedAt = $this->versionRepository->get(self::AUTH_REQUEST_STARTED_AT_KEY);

        if ($url === '' || $authRequestToken === '') {
            $this->clearAuthRequestState();
            $state['auth_request_pending'] = false;
            $state['auth_request_started_at'] = null;
            Response::json([
                'status' => 'error',
                'message' => 'No pending Joplin access request',
                'data' => $state,
            ], 422);
        }

        $result = $this->createJoplinService($url, '')->checkAccessRequest($authRequestToken);
        $requestStatus = (string) ($result['status'] ?? 'error');

        if ($requestStatus === 'waiting') {
            $state['auth_request_pending'] = true;
            $state['auth_request_started_at'] = $startedAt;
            $state['auth_request_status'] = 'waiting';
            Response::json(['status' => 'ok', 'data' => $state]);
        }

        $this->clearAuthRequestState();

        if ($requestStatus === 'accepted') {
            $newToken = trim((string) ($result['token'] ?? ''));
            if ($newToken === '') {
                Response::json([
                    'status' => 'error',
                    'message' => 'Joplin accepted the access request without returning a token',
                    'data' => $state,
                ], 502);
            }

            $tokenChanged = $existingToken === '' || !hash_equals($existingToken, $newToken);
            $autoDisabled = false;
            $enabled = (bool) ($state['enabled'] ?? false);
            if ($tokenChanged) {
                $this->versionRepository->set('joplin_api_token', $newToken);
                $this->clearVerificationState();
                if ($enabled) {
                    $enabled = false;
                    $autoDisabled = true;
                    $this->versionRepository->set('joplin_enabled', '0');
                }
            }

            $updatedState = $this->buildConfigState($enabled, $url, $newToken, $interval);
            $updatedState['auto_disabled'] = $autoDisabled;
            $updatedState['auth_request_pending'] = false;
            $updatedState['auth_request_started_at'] = null;
            $updatedState['auth_request_status'] = 'accepted';

            $this->logRepository->log(null, 'admin.joplin.auth.accepted', [
                'url' => $url,
                'token_changed' => $tokenChanged,
                'auto_disabled' => $autoDisabled,
            ]);

            Response::json(['status' => 'ok', 'data' => $updatedState]);
        }

        if ($requestStatus === 'rejected') {
            $state['auth_request_pending'] = false;
            $state['auth_request_started_at'] = null;
            $state['auth_request_status'] = 'rejected';

            $this->logRepository->log(null, 'admin.joplin.auth.rejected', [
                'url' => $url,
            ]);

            Response::json(['status' => 'ok', 'data' => $state]);
        }

        $state['auth_request_pending'] = false;
        $state['auth_request_started_at'] = null;
        $state['auth_request_status'] = 'error';
        Response::json([
            'status' => 'error',
            'message' => (string) ($result['reason'] ?? 'Joplin access request failed'),
            'data' => $state,
        ], 502);
    }

    /**
     * POST /admin/joplin/sync
     */
    public function postSync(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $state = $this->readConfigState();
        if (!$state['enabled']) {
            Response::json([
                'status' => 'error',
                'message' => 'Enable Joplin before running a sync',
                'data' => $state,
            ], 422);
        }

        if (!$state['verified_connection']) {
            Response::json([
                'status' => 'error',
                'message' => 'Run a successful connection test before syncing Joplin',
                'data' => $state,
            ], 422);
        }

        $sync = $this->runFullSyncOrFail();
        $state['sync'] = $sync;
        Response::json(['status' => 'ok', 'data' => $state]);
    }

    /**
     * @return array{
     *   enabled:bool,
     *   url:string,
     *   token_set:bool,
     *   sync_interval_minutes:int,
     *   config_complete:bool,
     *   verified_connection:bool,
     *   verified_at:?string,
     *   auth_request_pending:bool,
     *   auth_request_started_at:?string,
     *   can_activate:bool,
     *   activation_reason:string
     * }
     */
    private function readConfigState(): array
    {
        return $this->buildConfigState(
            $this->versionRepository->getFlag('joplin_enabled', false),
            (string) ($this->versionRepository->get('joplin_url') ?? ''),
            (string) ($this->versionRepository->get('joplin_api_token') ?? ''),
            (int) ($this->versionRepository->get('joplin_sync_interval_minutes') ?? '15')
        );
    }

    /**
     * @return array{
     *   enabled:bool,
     *   url:string,
     *   token_set:bool,
     *   sync_interval_minutes:int,
     *   config_complete:bool,
     *   verified_connection:bool,
     *   verified_at:?string,
     *   auth_request_pending:bool,
     *   auth_request_started_at:?string,
     *   can_activate:bool,
     *   activation_reason:string
     * }
     */
    private function buildConfigState(bool $enabled, string $url, string $token, int $interval): array
    {
        $normalizedUrl = $this->normalizeUrl($url);
        $token = trim($token);
        $tokenSet = $token !== '';
        $intervalValid = $interval >= 1 && $interval <= 1440;
        $configComplete = $normalizedUrl !== '' && $tokenSet && $intervalValid;
        $verifiedAt = $this->versionRepository->get(self::VERIFIED_AT_KEY);
        $authRequestPending = trim((string) ($this->versionRepository->get(self::AUTH_REQUEST_TOKEN_KEY) ?? '')) !== '';
        $authRequestStartedAt = $authRequestPending ? $this->versionRepository->get(self::AUTH_REQUEST_STARTED_AT_KEY) : null;
        $expectedFingerprint = $this->verificationFingerprint($normalizedUrl, $token);
        $storedFingerprint = $this->versionRepository->get(self::VERIFIED_HASH_KEY) ?? '';
        $verifiedConnection = $configComplete
            && $expectedFingerprint !== null
            && $storedFingerprint !== ''
            && hash_equals($storedFingerprint, $expectedFingerprint);

        $activationReason = 'ready';
        if ($normalizedUrl === '') {
            $activationReason = 'missing_url';
        } elseif (!$tokenSet) {
            $activationReason = 'missing_token';
        } elseif (!$intervalValid) {
            $activationReason = 'invalid_interval';
        } elseif (!$verifiedConnection) {
            $activationReason = 'verification_required';
        }

        return [
            'enabled' => $enabled,
            'url' => $normalizedUrl,
            'token_set' => $tokenSet,
            'sync_interval_minutes' => $interval,
            'config_complete' => $configComplete,
            'verified_connection' => $verifiedConnection,
            'verified_at' => $verifiedConnection ? $verifiedAt : null,
            'auth_request_pending' => $authRequestPending,
            'auth_request_started_at' => $authRequestStartedAt,
            'can_activate' => $activationReason === 'ready',
            'activation_reason' => $activationReason,
        ];
    }

    private function clearVerificationState(): void
    {
        $this->versionRepository->delete(self::VERIFIED_HASH_KEY);
        $this->versionRepository->delete(self::VERIFIED_AT_KEY);
    }

    private function clearAuthRequestState(): void
    {
        $this->versionRepository->delete(self::AUTH_REQUEST_TOKEN_KEY);
        $this->versionRepository->delete(self::AUTH_REQUEST_STARTED_AT_KEY);
    }

    private function normalizeUrl(string $url): string
    {
        $normalized = trim($url);
        return $normalized === '' ? '' : rtrim($normalized, '/');
    }

    private function verificationFingerprint(string $url, string $token): ?string
    {
        $normalizedUrl = $this->normalizeUrl($url);
        $trimmedToken = trim($token);
        if ($normalizedUrl === '' || $trimmedToken === '') {
            return null;
        }

        return hash('sha256', $normalizedUrl . "\n" . $trimmedToken);
    }

    private function activationBlockedMessage(string $reason): string
    {
        return match ($reason) {
            'missing_url' => 'Save a Joplin URL before enabling the module',
            'missing_token' => 'Save or request a Joplin access token before enabling the module',
            'invalid_interval' => 'Save a valid Joplin sync interval before enabling the module',
            default => 'Run a successful connection test on the saved Joplin configuration before enabling the module',
        };
    }

    /**
     * @return array{synced:int, errors:int, notebooks:int}
     */
    private function runFullSyncOrFail(): array
    {
        if ($this->joplinCacheService === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Joplin sync service is not available',
            ], 503);
        }

        try {
            $result = $this->joplinCacheService->syncAll();
            if (!isset($result['synced'], $result['errors'], $result['notebooks'])) {
                $result['notebooks'] = 0;
            }

            return [
                'synced' => (int) ($result['synced'] ?? 0),
                'errors' => (int) ($result['errors'] ?? 0),
                'notebooks' => (int) ($result['notebooks'] ?? 0),
            ];
        } catch (\Throwable $exception) {
            Response::json([
                'status' => 'error',
                'message' => 'Initial Joplin sync failed: ' . $exception->getMessage(),
            ], 502);
        }
    }

    private function createJoplinService(string $url, string $token): JoplinService
    {
        return new JoplinService($url, $token);
    }
}
