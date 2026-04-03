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

class AdminJoplinController
{
    private const VERIFIED_HASH_KEY = 'joplin_verified_config_hash';
    private const VERIFIED_AT_KEY = 'joplin_verified_at';

    public function __construct(
        private readonly VersionRepository $versionRepository,
        private readonly LogRepository $logRepository,
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
            if ($enabled) {
                $enabled = false;
                $autoDisabled = true;
            }
        }

        $this->versionRepository->set('joplin_enabled', $enabled ? '1' : '0');

        $this->logRepository->log(null, 'admin.joplin.config', [
            'fields_updated' => array_keys($payload),
            'connection_config_changed' => $connectionConfigChanged,
            'auto_disabled' => $autoDisabled,
            'enabled' => $enabled,
        ]);

        $updatedState = $this->buildConfigState($enabled, $url, $token, $interval);
        $updatedState['auto_disabled'] = $autoDisabled;

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

        $testUrl = rtrim($url, '/') . '/ping?token=' . rawurlencode($token);
        $context = stream_context_create(['http' => ['method' => 'GET', 'timeout' => 5.0, 'ignore_errors' => true]]);
        $response = @file_get_contents($testUrl, false, $context);

        $status = null;
        if (isset($http_response_header[0]) && preg_match('#\s(\d{3})\s#', $http_response_header[0], $m)) {
            $status = (int) $m[1];
        }

        $reachable = $response !== false && $status === 200;

        if ($reachable) {
            $this->versionRepository->set(self::VERIFIED_HASH_KEY, $this->verificationFingerprint($url, $token) ?? '');
            $this->versionRepository->set(self::VERIFIED_AT_KEY, gmdate(DATE_ATOM));
        } else {
            $this->clearVerificationState();
        }

        $updatedState = $this->buildConfigState((bool) ($state['enabled'] ?? false), $url, $token, $interval);
        $updatedState['reachable'] = $reachable;
        $updatedState['status_code'] = $status;

        Response::json(['status' => 'ok', 'data' => $updatedState]);
    }

    /**
     * POST /admin/joplin/sync
     */
    public function postSync(): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        // TODO: wire to JoplinCacheService::syncAll() once that service is merged in.
        Response::json(['status' => 'ok', 'data' => ['synced' => 0, 'errors' => 0]]);
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
            'can_activate' => $activationReason === 'ready',
            'activation_reason' => $activationReason,
        ];
    }

    private function clearVerificationState(): void
    {
        $this->versionRepository->delete(self::VERIFIED_HASH_KEY);
        $this->versionRepository->delete(self::VERIFIED_AT_KEY);
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
            'missing_token' => 'Save a Joplin API token before enabling the module',
            'invalid_interval' => 'Save a valid Joplin sync interval before enabling the module',
            default => 'Run a successful connection test on the saved Joplin configuration before enabling the module',
        };
    }
}
