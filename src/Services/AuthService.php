<?php

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Support\Timestamp;
use DateTimeImmutable;

class AuthService
{
    private const INACTIVITY_WINDOW_DAYS = 30;
    private const VERSION_CACHE_TTL_SECONDS = 7200; // 2 hours

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly LogRepository $logs,
        private readonly VersionRepository $versions,
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

    public function sync(array $incomingAuth, array $host, ?string $clientVersion, ?string $wrapperVersion = null): array
    {
        if (!$incomingAuth) {
            throw new ValidationException(['auth' => ['Auth payload is required']]);
        }

        [$normalizedClientVersion, $normalizedWrapperVersion] = $this->normalizeVersions($clientVersion, $wrapperVersion);

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
            $this->hosts->updateAuth((int) $host['id'], $encodedAuth, $lastRefresh, $normalizedClientVersion, $normalizedWrapperVersion);
            $host = $this->hosts->findById((int) $host['id']) ?? $host;
            $storedAuth = $incomingAuth;
            $response = [
                'result' => $result,
                'host' => $this->buildHostPayload($host),
                'auth' => $storedAuth,
                'last_refresh' => $host['last_refresh'] ?? null,
            ];
        } else {
            // Track version + last contact even when not accepting the incoming payload.
            $this->hosts->updateClientVersions((int) $host['id'], $normalizedClientVersion, $normalizedWrapperVersion);
            $host = $this->hosts->findById((int) $host['id']) ?? $host;

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
            'client_version' => $normalizedClientVersion,
            'wrapper_version' => $normalizedWrapperVersion,
        ]);

        $this->statusExporter->generate();

        return $response;
    }

    public function checkAuth(array $metadata, array $host, ?string $clientVersion, ?string $wrapperVersion): array
    {
        [$normalizedClientVersion, $normalizedWrapperVersion] = $this->normalizeVersions($clientVersion, $wrapperVersion);

        $incomingLastRefresh = null;
        if (isset($metadata['last_refresh']) && is_string($metadata['last_refresh'])) {
            $incomingLastRefresh = trim($metadata['last_refresh']);
            if ($incomingLastRefresh === '') {
                $incomingLastRefresh = null;
            }
        }

        if ($incomingLastRefresh === null) {
            throw new ValidationException(['last_refresh' => ['last_refresh is required']]);
        }

        $incomingDigest = $this->normalizeDigest($metadata['auth_sha'] ?? null);
        if ($incomingDigest === null) {
            throw new ValidationException(['auth_sha' => ['auth_sha is required']]);
        }

        $this->hosts->updateClientVersions((int) $host['id'], $normalizedClientVersion, $normalizedWrapperVersion);
        $host = $this->hosts->findById((int) $host['id']) ?? $host;

        $storedJson = $host['auth_json'] ?? null;
        $storedLastRefresh = $host['last_refresh'] ?? null;
        $storedDigest = $this->calculateDigest($storedJson);

        $status = 'missing';
        $response = [
            'status' => $status,
            'last_refresh' => $storedLastRefresh,
            'auth_digest' => $storedDigest,
            'action' => 'upload',
        ];

        if ($storedJson) {
            $comparison = Timestamp::compare($incomingLastRefresh, $storedLastRefresh);
            $digestsMatch = $storedDigest && hash_equals($storedDigest, $incomingDigest);

            if ($comparison === 0 && $digestsMatch) {
                $status = 'valid';
                $response = [
                    'status' => $status,
                    'last_refresh' => $storedLastRefresh,
                    'auth_digest' => $storedDigest,
                ];
            } elseif ($comparison === 1) {
                $status = 'upload_required';
                $response = [
                    'status' => $status,
                    'last_refresh' => $storedLastRefresh,
                    'auth_digest' => $storedDigest,
                    'action' => 'upload',
                ];
            } else {
                $status = 'outdated';
                $response = [
                    'status' => $status,
                    'last_refresh' => $storedLastRefresh,
                    'auth_digest' => $storedDigest,
                    'host' => $this->buildHostPayload($host),
                    'auth' => json_decode($storedJson, true),
                    'action' => 'sync',
                ];
            }
        }

        $this->logs->log((int) $host['id'], 'auth.check', [
            'status' => $status,
            'incoming_last_refresh' => $incomingLastRefresh,
            'incoming_digest' => $incomingDigest,
            'stored_last_refresh' => $storedLastRefresh,
            'stored_digest' => $storedDigest,
        ]);

        return $response;
    }

    private function buildHostPayload(array $host, bool $includeApiKey = false): array
    {
        $payload = [
            'fqdn' => $host['fqdn'],
            'status' => $host['status'],
            'last_refresh' => $host['last_refresh'] ?? null,
            'updated_at' => $host['updated_at'] ?? null,
            'client_version' => $host['client_version'] ?? null,
            'wrapper_version' => $host['wrapper_version'] ?? null,
        ];

        if ($includeApiKey) {
            $payload['api_key'] = $host['api_key'];
        }

        return $payload;
    }

    public function latestReportedVersions(): array
    {
        $hosts = $this->hosts->all();

        $latestClient = null;
        $latestWrapper = null;

        foreach ($hosts as $host) {
            $client = $host['client_version'] ?? null;
            if (is_string($client) && $client !== '') {
                if ($latestClient === null || $this->isVersionGreater($client, $latestClient)) {
                    $latestClient = $client;
                }
            }

            $wrapper = $host['wrapper_version'] ?? null;
            if (is_string($wrapper) && $wrapper !== '') {
                if ($latestWrapper === null || $this->isVersionGreater($wrapper, $latestWrapper)) {
                    $latestWrapper = $wrapper;
                }
            }
        }

        return [
            'client_version' => $latestClient,
            'wrapper_version' => $latestWrapper,
        ];
    }

    public function availableClientVersion(): array
    {
        $cached = $this->versions->getWithMetadata('client_available');
        $now = time();
        $cacheFresh = false;

        if ($cached && isset($cached['updated_at'])) {
            $updatedAt = strtotime($cached['updated_at']);
            if ($updatedAt !== false && ($now - $updatedAt) <= self::VERSION_CACHE_TTL_SECONDS) {
                $cacheFresh = true;
            }
        }

        if ($cacheFresh && isset($cached['version'])) {
            return [
                'version' => $cached['version'],
                'updated_at' => $cached['updated_at'] ?? null,
                'source' => 'cache',
            ];
        }

        $fetched = $this->fetchLatestCodexVersion();
        if ($fetched !== null) {
            $this->versions->set('client_available', $fetched);
            return [
                'version' => $fetched,
                'updated_at' => gmdate(DATE_ATOM),
                'source' => 'github',
            ];
        }

        if ($cached && isset($cached['version'])) {
            return [
                'version' => $cached['version'],
                'updated_at' => $cached['updated_at'] ?? null,
                'source' => 'cache_stale',
            ];
        }

        return [
            'version' => null,
            'updated_at' => null,
            'source' => 'unknown',
        ];
    }

    public function publishedVersions(): array
    {
        $all = $this->versions->all();

        return [
            'client_version' => $all['client'] ?? null,
            'wrapper_version' => $all['wrapper'] ?? null,
        ];
    }

    public function updatePublishedVersions(?string $clientVersion, ?string $wrapperVersion): array
    {
        if ($clientVersion !== null) {
            $this->versions->set('client', trim($clientVersion));
        }
        if ($wrapperVersion !== null) {
            $this->versions->set('wrapper', trim($wrapperVersion));
        }

        $this->logs->log(null, 'version.publish', [
            'client_version' => $clientVersion,
            'wrapper_version' => $wrapperVersion,
        ]);

        return $this->publishedVersions();
    }

    public function seedWrapperVersionFromReported(?string $wrapperVersion): void
    {
        if ($wrapperVersion === null || trim($wrapperVersion) === '') {
            return;
        }

        $published = $this->publishedVersions();
        if ($published['wrapper_version'] !== null) {
            return;
        }

        $normalized = trim($wrapperVersion);
        $this->versions->set('wrapper', $normalized);
        $this->logs->log(null, 'version.seed', [
            'wrapper_version' => $normalized,
            'source' => 'reported_fallback',
        ]);
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

    /**
     * @return array{0:string,1:?string}
     */
    private function normalizeVersions(?string $clientVersion, ?string $wrapperVersion): array
    {
        $normalizedClientVersion = is_string($clientVersion) ? trim($clientVersion) : '';
        if ($normalizedClientVersion === '') {
            throw new ValidationException(['client_version' => ['client_version is required']]);
        }

        $normalizedWrapperVersion = null;
        if (is_string($wrapperVersion)) {
            $trimmed = trim($wrapperVersion);
            $normalizedWrapperVersion = $trimmed === '' ? null : $trimmed;
        }

        return [$normalizedClientVersion, $normalizedWrapperVersion];
    }

    private function isVersionGreater(string $left, string $right): bool
    {
        $left = trim($left);
        $right = trim($right);

        if ($left === '') {
            return false;
        }
        if ($right === '') {
            return true;
        }

        $cmp = version_compare($left, $right);

        return $cmp === 1;
    }

    private function fetchLatestCodexVersion(): ?string
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'GET',
                'header' => "User-Agent: codex-auth-api\r\nAccept: application/json\r\n",
                'timeout' => 5,
            ],
        ]);

        $json = @file_get_contents('https://api.github.com/repos/openai/codex/releases/latest', false, $context);
        if ($json === false) {
            return null;
        }

        $data = json_decode($json, true);
        if (!is_array($data)) {
            return null;
        }

        $candidates = [
            $data['tag_name'] ?? null,
            $data['name'] ?? null,
        ];

        foreach ($candidates as $candidate) {
            if (is_string($candidate)) {
                $normalized = trim($candidate);
                if ($normalized !== '') {
                    $normalized = ltrim($normalized, 'vV');
                    return $normalized;
                }
            }
        }

        return null;
    }

    private function normalizeDigest(mixed $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $value = strtolower(trim($value));

        return $value === '' ? null : $value;
    }

    private function calculateDigest(?string $authJson): ?string
    {
        if ($authJson === null || $authJson === '') {
            return null;
        }

        return hash('sha256', $authJson);
    }
}
