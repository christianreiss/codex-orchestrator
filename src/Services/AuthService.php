<?php

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Support\Timestamp;

class AuthService
{
    public function __construct(
        private readonly HostRepository $hosts,
        private readonly LogRepository $logs,
        private readonly string $invitationKey
    ) {
    }

    public function register(string $fqdn, string $invitationKey): array
    {
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
            $this->logs->log((int) $existing['id'], 'register', ['result' => 'existing']);

            return $this->buildHostPayload($existing, true);
        }

        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create($fqdn, $apiKey);
        $this->logs->log((int) $host['id'], 'register', ['result' => 'created']);

        return $this->buildHostPayload($host, true);
    }

    public function authenticate(?string $apiKey): array
    {
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

        $shouldUpdate = !$storedAuth || Timestamp::compare($lastRefresh, $storedLastRefresh) === 1;
        $result = $shouldUpdate ? 'updated' : 'unchanged';

        if ($shouldUpdate) {
            $this->hosts->updateAuth((int) $host['id'], $encodedAuth, $lastRefresh);
            $host = $this->hosts->findByApiKey($host['api_key']);
            $storedAuth = $incomingAuth;
        } else {
            $storedAuth = $storedAuth ?: $incomingAuth;
            $this->hosts->touch((int) $host['id']);
        }

        $this->logs->log((int) $host['id'], 'auth.sync', [
            'result' => $result,
            'incoming_last_refresh' => $lastRefresh,
            'stored_last_refresh' => $host['last_refresh'] ?? null,
        ]);

        return [
            'host' => $this->buildHostPayload($host),
            'auth' => $storedAuth,
            'last_refresh' => $host['last_refresh'] ?? null,
        ];
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
}
