<?php

namespace App\Http\Controllers;

use App\Http\Response;
use App\Http\RequestHelper;
use App\Http\VersionHelper;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Support\Engine;
use Throwable;

class HostApiController
{
    public function __construct(
        private AuthService $service,
        private HostRepository $hostRepository,
        private LogRepository $logRepository,
        private VersionRepository $versionRepository,
    ) {}

    // ---------------------------------------------------------------
    //  Host Users
    // ---------------------------------------------------------------

    public function recordUsers(mixed $payload): void
    {
        $host = $this->authenticateHost();

        $username = is_array($payload) ? (string) ($payload['username'] ?? '') : '';
        $hostname = is_array($payload) ? (string) ($payload['hostname'] ?? '') : '';
        $users = $this->service->recordHostUser($host, $username, $hostname);

        Response::json([
            'status' => 'ok',
            'data' => [
                'users' => $users,
            ],
        ]);
    }

    // ---------------------------------------------------------------
    //  Host Lane
    // ---------------------------------------------------------------

    public function getLane(): void
    {
        $host = $this->authenticateHost();
        $host = $this->service->enforceInsecureWindow($host, 'host_lane_get');

        $lanePreference = AuthService::normalizeQuotaLane($host['lane_preference'] ?? null);
        $effectiveLane = VersionHelper::resolveActiveQuotaLaneForHost($host, $this->versionRepository, $lanePreference);

        Response::json([
            'status' => 'ok',
            'data' => [
                'lane_preference' => $lanePreference,
                'effective_lane' => $effectiveLane,
                'host_id' => isset($host['id']) ? (int) $host['id'] : null,
                'fqdn' => $host['fqdn'] ?? null,
            ],
        ]);
    }

    public function setLane(mixed $payload): void
    {
        $host = $this->authenticateHost();
        $host = $this->service->enforceInsecureWindow($host, 'host_lane_set');

        $hostId = isset($host['id']) ? (int) $host['id'] : 0;
        if ($hostId <= 0) {
            Response::json([
                'status' => 'error',
                'message' => 'Host not found',
            ], 404);
        }

        if (!is_array($payload) || !array_key_exists('lane', $payload)) {
            Response::json([
                'status' => 'error',
                'message' => 'lane is required (set null to clear)',
            ], 422);
        }

        $laneRaw = $payload['lane'];
        if ($laneRaw !== null && !is_string($laneRaw)) {
            Response::json([
                'status' => 'error',
                'message' => 'lane must be one of: normal, spark, or null',
            ], 422);
        }

        $lanePreference = AuthService::normalizeQuotaLane($laneRaw);
        if ($laneRaw !== null && is_string($laneRaw) && trim($laneRaw) !== '' && $lanePreference === null) {
            Response::json([
                'status' => 'error',
                'message' => 'lane must be one of: normal, spark, or null',
            ], 422);
        }

        $this->hostRepository->updateLanePreference($hostId, $lanePreference);
        $updated = $this->hostRepository->findById($hostId) ?? $host;
        $effectiveLane = VersionHelper::resolveActiveQuotaLaneForHost($updated, $this->versionRepository, $lanePreference);
        $this->logRepository->log($hostId, 'host.lane.set', [
            'fqdn' => $updated['fqdn'] ?? ($host['fqdn'] ?? null),
            'lane_preference' => $lanePreference,
            'effective_lane' => $effectiveLane,
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'lane_preference' => $lanePreference,
                'effective_lane' => $effectiveLane,
                'host_id' => $hostId,
                'fqdn' => $updated['fqdn'] ?? ($host['fqdn'] ?? null),
            ],
        ]);
    }

    // ---------------------------------------------------------------
    //  Usage
    // ---------------------------------------------------------------

    public function recordUsage(mixed $payload): void
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();
        $engine = VersionHelper::extractEngine($payload);
        $host = $this->service->authenticate($apiKey, $clientIp);

        $usagePayload = is_array($payload) ? $payload : [];
        $usagePayload['engine'] = $engine;

        try {
            $data = $this->service->recordTokenUsage($host, $usagePayload, $clientIp);
            $data['engine'] = $engine;
        } catch (Throwable $exception) {
            error_log('Usage ingestion failed: ' . $exception->getMessage());
            Response::json([
                'status' => 'ok',
                'data' => [
                    'recorded' => false,
                    'reason' => 'usage ingestion failed',
                    'engine' => $engine,
                ],
            ]);
        }

        Response::json([
            'status' => 'ok',
            'data' => $data,
        ]);
    }

    // ---------------------------------------------------------------
    //  Helpers
    // ---------------------------------------------------------------

    /** @return array<string, mixed> */
    private function authenticateHost(): array
    {
        $apiKey = RequestHelper::resolveApiKey();
        $clientIp = RequestHelper::resolveClientIp();

        return $this->service->authenticate($apiKey, $clientIp);
    }
}
