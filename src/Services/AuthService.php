<?php

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Support\Timestamp;
use DateTimeImmutable;

class AuthService
{
    private const INACTIVITY_WINDOW_DAYS = 30;

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly LogRepository $logs,
        private readonly string $invitationKey,
        private readonly HostStatusExporter $statusExporter
    ) {
    }

    public function register(string $fqdn, string $invitationKey): array
    {
        $this->pruneInactiveHosts();

        $errors = [];
        if ($fqdn === '') {
            $errors['fqdn'][] = 'FQDN is required';
        }

        if ($invitationKey === '') {
            $errors['invitation_key'][] = 'Invitation key is required';
        }

        if ($errors) {
            throw new ValidationException($errors);
        }

        if (!hash_equals($this->invitationKey, $invitationKey)) {
            throw new HttpException('Invalid invitation key', 401);
        }

        $existing = $this->hosts->findByFqdn($fqdn);
        if ($existing) {
            $apiKey = bin2hex(random_bytes(32));
            $host = $this->hosts->rotateApiKey((int) $existing['id'], $apiKey);
            $this->logs->log((int) $existing['id'], 'register', ['result' => 'rotated']);
            $payload = $this->buildHostPayload($host ?? $existing, true);
            $this->statusExporter->generate();

            return $payload;
        }

        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create($fqdn, $apiKey);
        $this->logs->log((int) $host['id'], 'register', ['result' => 'created']);

        $payload = $this->buildHostPayload($host, true);
        $this->statusExporter->generate();

        return $payload;
    }

    public function authenticate(?string $apiKey, ?string $ip = null): array
    {
        $this->pruneInactiveHosts();

        if ($apiKey === null || $apiKey === '') {
            throw new HttpException('API key missing', 401);
        }

        $host = $this->hosts->findByApiKey($apiKey);
        if (!$host) {
            throw new HttpException('Invalid API key', 401);
        }

        if (($host['status'] ?? '') !== 'active') {
            throw new HttpException('Host is disabled', 403);
        }

        if ($ip !== null && $ip !== '') {
            $storedIp = $host['ip'] ?? null;
            if ($storedIp === null || $storedIp === '') {
                $this->hosts->updateIp((int) $host['id'], $ip);
                $this->logs->log((int) $host['id'], 'auth.bind_ip', ['ip' => $ip]);
                $host = $this->hosts->findById((int) $host['id']) ?? $host;
            } elseif (!hash_equals($storedIp, $ip)) {
                throw new HttpException('API key not allowed from this IP', 403, [
                    'expected_ip' => $storedIp,
                    'received_ip' => $ip,
                ]);
            }
        }

        return $host;
    }

    public function sync(array $incomingAuth, array $host): array
    {
        if (!$incomingAuth) {
            throw new ValidationException(['auth' => ['Auth payload is required']]);
        }

        $lastRefresh = $incomingAuth['last_refresh'] ?? null;
        if (!is_string($lastRefresh) || $lastRefresh === '') {
            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
        }

        $encodedAuth = json_encode($incomingAuth, JSON_UNESCAPED_SLASHES);
        if ($encodedAuth === false) {
            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
        }

        $storedJson = $host['auth_json'] ?? null;
        $storedAuth = $storedJson ? json_decode($storedJson, true) : null;
        $storedLastRefresh = $host['last_refresh'] ?? null;

        $comparison = Timestamp::compare($lastRefresh, $storedLastRefresh);
        $shouldUpdate = !$storedAuth || $comparison === 1;
        $result = $shouldUpdate ? 'updated' : 'unchanged';

        if ($shouldUpdate) {
            $this->hosts->updateAuth((int) $host['id'], $encodedAuth, $lastRefresh);
            $host = $this->hosts->findByApiKey($host['api_key']);
            $storedAuth = $incomingAuth;
            $response = [
                'result' => $result,
                'host' => $this->buildHostPayload($host),
                'auth' => $storedAuth,
                'last_refresh' => $host['last_refresh'] ?? null,
            ];
        } else {
            // Touch even when not accepting the incoming payload so pruning logic retains the host.
            $this->hosts->touch((int) $host['id']);

            $storedAuth = $storedAuth ?: $incomingAuth;
            $incomingIsOlder = $storedLastRefresh !== null && $comparison === -1;

            if ($incomingIsOlder && $storedAuth) {
                // Client is behind: return the canonical server copy so it can self-heal.
                $response = [
                    'result' => $result,
                    'host' => $this->buildHostPayload($host),
                    'auth' => $storedAuth,
                    'last_refresh' => $host['last_refresh'] ?? null,
                ];
            } else {
                // Equal timestamps (or no canonical copy): minimal unchanged response.
                $response = [
                    'result' => $result,
                    'last_refresh' => $host['last_refresh'] ?? null,
                ];
            }
        }

        $this->logs->log((int) $host['id'], 'auth.sync', [
            'result' => $result,
            'incoming_last_refresh' => $lastRefresh,
            'stored_last_refresh' => $host['last_refresh'] ?? null,
        ]);

        $this->statusExporter->generate();

        return $response;
    }

    private function buildHostPayload(array $host, bool $includeApiKey = false): array
    {
        $payload = [
            'fqdn' => $host['fqdn'],
            'status' => $host['status'],
            'last_refresh' => $host['last_refresh'] ?? null,
            'updated_at' => $host['updated_at'] ?? null,
        ];

        if ($includeApiKey) {
            $payload['api_key'] = $host['api_key'];
        }

        return $payload;
    }

    private function pruneInactiveHosts(): void
    {
        $cutoff = (new DateTimeImmutable(sprintf('-%d days', self::INACTIVITY_WINDOW_DAYS)));
        $cutoffTimestamp = $cutoff->format(DATE_ATOM);
        $staleHosts = $this->hosts->findInactiveBefore($cutoffTimestamp);

        if (!$staleHosts) {
            return;
        }

        foreach ($staleHosts as $host) {
            $hostId = (int) $host['id'];
            $this->logs->log($hostId, 'host.pruned', [
                'reason' => 'inactive',
                'cutoff' => $cutoffTimestamp,
                'last_contact' => $host['updated_at'] ?? null,
                'fqdn' => $host['fqdn'],
            ]);
        }

        $ids = array_map(static fn (array $host) => (int) $host['id'], $staleHosts);
        $this->hosts->deleteByIds($ids);
        $this->statusExporter->generate();
    }
}
