<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Response;
use App\Http\VersionHelper;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Support\ClaudeVersionPolicy;
use App\Support\CodexVersionPolicy;
use App\Support\Engine;

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
        $engine = VersionHelper::extractEngine($payload);

        $this->hostRepository->touchLastCronCheck($hostId);

        $submittedVersion = VersionHelper::extractClientVersion($payload);
        $submittedWrapperVersion = VersionHelper::extractWrapperVersion($payload);
        if ($submittedVersion !== null || $submittedWrapperVersion !== null) {
            if ($engine === Engine::CLAUDE) {
                $this->hostRepository->updateClaudeVersions($hostId, $submittedVersion, $submittedWrapperVersion);
                if ($submittedVersion !== null) {
                    $host['claude_client_version'] = $submittedVersion;
                }
                if ($submittedWrapperVersion !== null) {
                    $host['claude_wrapper_version'] = $submittedWrapperVersion;
                }
            } else {
                $this->hostRepository->updateReportedVersions($hostId, $submittedVersion, $submittedWrapperVersion);
                if ($submittedVersion !== null) {
                    $host['client_version'] = $submittedVersion;
                }
                if ($submittedWrapperVersion !== null) {
                    $host['wrapper_version'] = $submittedWrapperVersion;
                }
            }
        }

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
                'data' => [
                    'action' => 'disable',
                    'wrapper' => [
                        'action' => 'no_update',
                        'target_version' => null,
                        'sha256' => null,
                        'url' => null,
                    ],
                ],
            ]);
        }

        // Resolve effective target version for this host.
        $versions = $this->service->versionSummary($engine);
        $versions = $this->service->applyClientVersionOverrideForHost($versions, $host, $engine);

        $targetVersion = $engine === Engine::CLAUDE
            ? ClaudeVersionPolicy::normalize($versions['client_version'] ?? null)
            : CodexVersionPolicy::normalize($versions['client_version'] ?? null);
        $enforceExact = $versions['client_version_enforce_exact'] ?? false;

        $needClientUpdate = false;
        if ($targetVersion !== null && $submittedVersion !== null) {
            if ($enforceExact) {
                $needClientUpdate = ($submittedVersion !== $targetVersion);
            } else {
                $needClientUpdate = version_compare($submittedVersion, $targetVersion, '<');
            }
        } elseif ($targetVersion !== null && $submittedVersion === null) {
            $needClientUpdate = true;
        }

        $targetWrapperVersion = $engine === Engine::CLAUDE
            ? ClaudeVersionPolicy::normalize($versions['wrapper_version'] ?? null)
            : CodexVersionPolicy::normalize($versions['wrapper_version'] ?? null);
        $wrapperUpdate = [
            'action' => 'no_update',
            'target_version' => $targetWrapperVersion,
            'sha256' => $versions['wrapper_sha256'] ?? null,
            'url' => $versions['wrapper_url'] ?? null,
        ];

        $needWrapperUpdate = false;
        if ($targetWrapperVersion !== null) {
            $needWrapperUpdate = $submittedWrapperVersion === null || $submittedWrapperVersion !== $targetWrapperVersion;
            if ($needWrapperUpdate) {
                $wrapperUpdate['action'] = 'update';
            }
        }

        if (!$needClientUpdate && !$needWrapperUpdate) {
            Response::json([
                'status' => 'ok',
                'data' => [
                    'action' => 'no_update',
                    'wrapper' => $wrapperUpdate,
                ],
            ]);
        }

        // Determine the release tag candidates for the client to resolve from GitHub.
        $tag = $targetVersion;

        $this->logRepository->log($hostId, 'cron.update_available', [
            'client' => [
                'current' => $submittedVersion,
                'target' => $targetVersion,
                'needs_update' => $needClientUpdate,
                'enforce_exact' => $enforceExact,
            ],
            'wrapper' => [
                'current' => $submittedWrapperVersion,
                'target' => $targetWrapperVersion,
                'needs_update' => $needWrapperUpdate,
                'sha256' => $versions['wrapper_sha256'] ?? null,
                'url' => $versions['wrapper_url'] ?? null,
            ],
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'action' => $needClientUpdate ? 'update' : 'no_update',
                'target_version' => $needClientUpdate ? $targetVersion : null,
                'tag' => $tag,
                'enforce_exact' => $enforceExact,
                'wrapper' => $wrapperUpdate,
            ],
        ]);
    }

    public function report(array $payload): void
    {
        $apiKey = resolveApiKey();
        $clientIp = resolveClientIp();
        $host = $this->service->authenticateForCron($apiKey, $clientIp);
        $hostId = (int) $host['id'];
        $engine = VersionHelper::extractEngine($payload);

        $clientVersion = VersionHelper::extractClientVersion($payload);
        $wrapperVersion = VersionHelper::extractWrapperVersion($payload);
        if ($clientVersion === null && $wrapperVersion === null) {
            Response::json([
                'status' => 'error',
                'message' => 'client_version or wrapper_version is required',
            ], 422);
        }

        if ($engine === Engine::CLAUDE) {
            $this->hostRepository->updateClaudeVersions($hostId, $clientVersion, $wrapperVersion);
        } else {
            $this->hostRepository->updateReportedVersions($hostId, $clientVersion, $wrapperVersion);
        }

        $this->logRepository->log($hostId, 'cron.update_reported', [
            'client' => [
                'reported' => $clientVersion,
            ],
            'wrapper' => [
                'reported' => $wrapperVersion,
            ],
        ]);

        Response::json([
            'status' => 'ok',
            'data' => ['recorded' => true],
        ]);
    }
}
