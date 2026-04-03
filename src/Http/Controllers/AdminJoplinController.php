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

        $enabled = $this->versionRepository->getFlag('joplin_enabled', false);
        $url = $this->versionRepository->get('joplin_url') ?? '';
        $token = $this->versionRepository->get('joplin_api_token') ?? '';
        $interval = (int) ($this->versionRepository->get('joplin_sync_interval_minutes') ?? '15');

        Response::json(['status' => 'ok', 'data' => [
            'enabled' => $enabled,
            'url' => $url,
            'token_set' => $token !== '',
            'sync_interval_minutes' => $interval,
        ]]);
    }

    /**
     * POST /admin/joplin/config
     */
    public function postConfig(array $payload): void
    {
        requireAdminAccess();
        requireAdminCapability(AdminAuthService::CAP_SETTINGS);

        $enabled = $this->versionRepository->getFlag('joplin_enabled', false);
        $url = $this->versionRepository->get('joplin_url') ?? '';
        $token = $this->versionRepository->get('joplin_api_token') ?? '';
        $interval = (int) ($this->versionRepository->get('joplin_sync_interval_minutes') ?? '15');

        if (array_key_exists('enabled', $payload)) {
            $enabled = normalizeBoolean($payload['enabled']);
            if ($enabled === null) {
                Response::json(['status' => 'error', 'message' => 'enabled must be boolean'], 422);
            }
            $this->versionRepository->set('joplin_enabled', $enabled ? '1' : '0');
        }

        if (array_key_exists('url', $payload)) {
            $url = trim((string) $payload['url']);
            if ($url !== '' && !preg_match('#^https?://#i', $url)) {
                Response::json(['status' => 'error', 'message' => 'url must be a valid http/https URL'], 422);
            }
            $this->versionRepository->set('joplin_url', $url);
        }

        if (array_key_exists('token', $payload)) {
            $newToken = trim((string) $payload['token']);
            if ($newToken !== '') {
                $token = $newToken;
                $this->versionRepository->set('joplin_api_token', $token);
            }
        }

        if (array_key_exists('sync_interval_minutes', $payload)) {
            $interval = (int) $payload['sync_interval_minutes'];
            if ($interval < 1 || $interval > 1440) {
                Response::json(['status' => 'error', 'message' => 'sync_interval_minutes must be between 1 and 1440'], 422);
            }
            $this->versionRepository->set('joplin_sync_interval_minutes', (string) $interval);
        }

        $this->logRepository->log(null, 'admin.joplin.config', [
            'fields_updated' => array_keys($payload),
        ]);

        Response::json(['status' => 'ok', 'data' => [
            'enabled' => $enabled,
            'url' => $url,
            'token_set' => $token !== '',
            'sync_interval_minutes' => $interval,
        ]]);
    }

    /**
     * POST /admin/joplin/test
     */
    public function postTest(array $payload): void
    {
        requireAdminAccess();

        $url = trim((string) ($payload['url'] ?? $this->versionRepository->get('joplin_url') ?? ''));
        $token = trim((string) ($payload['token'] ?? $this->versionRepository->get('joplin_api_token') ?? ''));

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

        Response::json(['status' => 'ok', 'data' => ['reachable' => $reachable, 'status_code' => $status]]);
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
}
