<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Support\CodexVersionPolicy;

class CronController
{
    public function __construct(
        private AuthService $service,
        private HostRepository $hostRepository,
        private VersionRepository $versionRepository,
        private LogRepository $logRepository,
    ) {}

    public function check(array $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticateForCron($apiKey, $clientIp);
        $hostId = (int) $host['id'];

        $this->hostRepository->touchLastCronCheck($hostId);

        // Resolve effective auto-update setting: per-host override wins, then fleet default.
        $override = $host['auto_update_override'] ?? null;
        if ($override !== null) {
            $autoUpdateEnabled = (bool) (int) $override;
        } else {
            $autoUpdateEnabled = $this->versionRepository->getFlag('auto_update_enabled', false);
        }

        if (!$autoUpdateEnabled) {
            Response::json([
                'status' => 'ok',
                'data' => ['action' => 'disable'],
            ]);
        }

        // Resolve effective target version for this host.
        $versions = $this->service->versionSummary();
        $versions = $this->service->applyClientVersionOverrideForHost($versions, $host);

        $targetVersion = CodexVersionPolicy::normalize($versions['client_version'] ?? null);
        $enforceExact = $versions['client_version_enforce_exact'] ?? false;
        $submittedVersion = CodexVersionPolicy::normalize($payload['client_version'] ?? null);

        $needUpdate = false;
        if ($targetVersion !== null && $submittedVersion !== null) {
            if ($enforceExact) {
                $needUpdate = ($submittedVersion !== $targetVersion);
            } else {
                $needUpdate = version_compare($submittedVersion, $targetVersion, '<');
            }
        } elseif ($targetVersion !== null && $submittedVersion === null) {
            $needUpdate = true;
        }

        if (!$needUpdate) {
            Response::json([
                'status' => 'ok',
                'data' => ['action' => 'no_update'],
            ]);
        }

        // Determine the release tag candidates for the client to resolve from GitHub.
        $tag = $targetVersion;

        $this->logRepository->log($hostId, 'cron.update_available', [
            'current' => $submittedVersion,
            'target' => $targetVersion,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'action' => 'update',
                'target_version' => $targetVersion,
                'tag' => $tag,
                'enforce_exact' => $enforceExact,
            ],
        ]);
    }

    public function report(array $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticateForCron($apiKey, $clientIp);
        $hostId = (int) $host['id'];

        $clientVersion = $payload['client_version'] ?? null;
        if (!is_string($clientVersion) || trim($clientVersion) === '') {
            Response::json([
                'status' => 'error',
                'message' => 'client_version is required',
            ], 422);
        }

        $normalized = CodexVersionPolicy::normalize($clientVersion);
        if ($normalized === null) {
            Response::json([
                'status' => 'error',
                'message' => 'Invalid client_version',
            ], 422);
        }

        $this->hostRepository->updateClientVersions($hostId, $normalized, $host['wrapper_version'] ?? null);

        $this->logRepository->log($hostId, 'cron.update_reported', [
            'client_version' => $normalized,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['recorded' => true],
        ]);
    }
}
