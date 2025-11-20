<?php

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\HostAuthDigestRepository;
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
        private readonly HostAuthDigestRepository $digests,
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

    public function handleAuth(array $payload, array $host, ?string $clientVersion, ?string $wrapperVersion = null): array
    {
        [$normalizedClientVersion, $normalizedWrapperVersion] = $this->normalizeVersions($clientVersion, $wrapperVersion);

        $command = $this->normalizeCommand($payload['command'] ?? null);

        $this->hosts->updateClientVersions((int) $host['id'], $normalizedClientVersion, $normalizedWrapperVersion);
        $this->hosts->incrementApiCalls((int) $host['id']);
        $host = $this->hosts->findById((int) $host['id']) ?? $host;

        $storedJson = $host['auth_json'] ?? null;
        $storedLastRefresh = $host['last_refresh'] ?? null;
        $storedDigest = $host['auth_digest'] ?? $this->calculateDigest($storedJson);

        if ($storedDigest !== null && (!isset($host['auth_digest']) || $host['auth_digest'] !== $storedDigest)) {
            $this->hosts->updateAuthDigest((int) $host['id'], $storedDigest, $host['updated_at'] ?? null);
            $host = $this->hosts->findById((int) $host['id']) ?? $host;
        }

        $recentDigests = $this->digests->recentDigests((int) $host['id']);
        if ($storedDigest !== null && !in_array($storedDigest, $recentDigests, true)) {
            $this->digests->rememberDigests((int) $host['id'], [$storedDigest]);
            $recentDigests = $this->digests->recentDigests((int) $host['id']);
        }

        $versions = $this->versionSnapshot();

        if ($command === 'retrieve') {
            $providedDigest = $this->extractDigest($payload, true);
            $incomingLastRefresh = $this->extractLastRefresh($payload, 'last_refresh');

            $status = 'missing';
            $response = [
                'status' => $status,
                'canonical_last_refresh' => $storedLastRefresh,
                'canonical_digest' => $storedDigest,
                'action' => 'store',
                'api_calls' => (int) ($host['api_calls'] ?? 0),
                'versions' => $versions,
            ];

            if ($storedJson && $storedDigest !== null) {
                $comparison = Timestamp::compare($incomingLastRefresh, $storedLastRefresh);
                $matchesCanonical = hash_equals($storedDigest, $providedDigest);
                $matchesRecent = in_array($providedDigest, $recentDigests, true);

                if ($matchesCanonical) {
                    $status = 'valid';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $storedLastRefresh,
                        'canonical_digest' => $storedDigest,
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];
                } elseif ($comparison === 1 || !$matchesRecent) {
                    $status = 'upload_required';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $storedLastRefresh,
                        'canonical_digest' => $storedDigest,
                        'action' => 'store',
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];
                } else {
                    $status = 'outdated';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $storedLastRefresh,
                        'canonical_digest' => $storedDigest,
                        'host' => $this->buildHostPayload($host),
                        'auth' => json_decode($storedJson, true),
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];
                }
            }

            $this->logs->log((int) $host['id'], 'auth.retrieve', [
                'status' => $status,
                'incoming_last_refresh' => $incomingLastRefresh,
                'incoming_digest' => $providedDigest,
                'stored_last_refresh' => $storedLastRefresh,
                'stored_digest' => $storedDigest,
            ]);

            return $response;
        }

        // store command
        $incomingAuth = $this->extractAuthPayload($payload);
        $incomingLastRefresh = $incomingAuth['last_refresh'] ?? null;
        if (!is_string($incomingLastRefresh) || trim($incomingLastRefresh) === '') {
            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
        }

        $encodedAuth = json_encode($incomingAuth, JSON_UNESCAPED_SLASHES);
        if ($encodedAuth === false) {
            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
        }

        $incomingDigest = $this->calculateDigest($encodedAuth);
        $this->digests->rememberDigests((int) $host['id'], [$incomingDigest]);

        $comparison = Timestamp::compare($incomingLastRefresh, $storedLastRefresh);
        $shouldUpdate = !$storedJson || $comparison === 1;
        $status = $shouldUpdate ? 'updated' : ($comparison === -1 ? 'outdated' : 'unchanged');

        if ($shouldUpdate) {
            $this->hosts->updateAuth((int) $host['id'], $encodedAuth, $incomingLastRefresh, $incomingDigest, $normalizedClientVersion, $normalizedWrapperVersion);
            $host = $this->hosts->findById((int) $host['id']) ?? $host;
            $storedJson = $encodedAuth;
            $storedLastRefresh = $incomingLastRefresh;
            $storedDigest = $incomingDigest;

            $response = [
                'status' => $status,
                'host' => $this->buildHostPayload($host),
                'auth' => $incomingAuth,
                'canonical_last_refresh' => $storedLastRefresh,
                'canonical_digest' => $storedDigest,
                'api_calls' => (int) ($host['api_calls'] ?? 0),
                'versions' => $versions,
            ];

            $this->statusExporter->generate();
        } else {
            $host = $this->hosts->findById((int) $host['id']) ?? $host;

            if ($status === 'outdated' && $storedJson) {
                $response = [
                    'status' => $status,
                    'host' => $this->buildHostPayload($host),
                    'auth' => json_decode($storedJson, true),
                    'canonical_last_refresh' => $storedLastRefresh,
                    'canonical_digest' => $storedDigest,
                    'api_calls' => (int) ($host['api_calls'] ?? 0),
                    'versions' => $versions,
                ];
            } else {
                $response = [
                    'status' => $status,
                    'canonical_last_refresh' => $storedLastRefresh,
                    'canonical_digest' => $storedDigest,
                    'api_calls' => (int) ($host['api_calls'] ?? 0),
                    'versions' => $versions,
                ];
            }
        }

        $this->logs->log((int) $host['id'], 'auth.store', [
            'status' => $status,
            'incoming_last_refresh' => $incomingLastRefresh,
            'incoming_digest' => $incomingDigest,
            'stored_last_refresh' => $storedLastRefresh,
            'stored_digest' => $storedDigest,
            'client_version' => $normalizedClientVersion,
            'wrapper_version' => $normalizedWrapperVersion,
        ]);

        return $response;
    }

    private function versionSnapshot(): array
    {
        $available = $this->availableClientVersion();
        $reported = $this->latestReportedVersions();
        $this->seedWrapperVersionFromReported($reported['wrapper_version']);
        $published = $this->publishedVersions();

        $clientVersion = $available['version'] ?? $published['client_version'] ?? $reported['client_version'];
        $wrapperVersion = $published['wrapper_version'] ?? $reported['wrapper_version'];

        return [
            'client_version' => $clientVersion,
            'client_version_checked_at' => $available['updated_at'] ?? null,
            'wrapper_version' => $wrapperVersion,
            'reported_client_version' => $reported['client_version'],
            'reported_wrapper_version' => $reported['wrapper_version'],
        ];
    }

    private function normalizeCommand(mixed $command): string
    {
        if (!is_string($command) || trim($command) === '') {
            return 'retrieve';
        }

        $normalized = strtolower(trim($command));
        if (!in_array($normalized, ['retrieve', 'store'], true)) {
            throw new ValidationException(['command' => ['command must be "retrieve" or "store"']]);
        }

        return $normalized;
    }

    private function extractLastRefresh(array $payload, string $field): string
    {
        if (!array_key_exists($field, $payload) || !is_string($payload[$field])) {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        $value = trim($payload[$field]);
        if ($value === '') {
            throw new ValidationException([$field => [$field . ' is required']]);
        }

        return $value;
    }

    private function extractAuthPayload(array $payload): array
    {
        if (array_key_exists('auth', $payload) && is_array($payload['auth'])) {
            return $payload['auth'];
        }

        if (array_key_exists('last_refresh', $payload)) {
            return $payload;
        }

        throw new ValidationException(['auth' => ['Auth payload is required']]);
    }

    private function extractDigest(array $payload, bool $required): ?string
    {
        $candidates = [
            $payload['digest'] ?? null,
            $payload['auth_digest'] ?? null,
            $payload['auth_sha'] ?? null,
        ];

        foreach ($candidates as $candidate) {
            $normalized = $this->normalizeDigest($candidate);
            if ($normalized !== null) {
                if (!preg_match('/^[a-f0-9]{64}$/', $normalized)) {
                    throw new ValidationException(['digest' => ['digest must be a 64-character hex sha256 value']]);
                }

                return $normalized;
            }
        }

        if ($required) {
            throw new ValidationException(['digest' => ['digest is required']]);
        }

        return null;
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
            'api_calls' => isset($host['api_calls']) ? (int) $host['api_calls'] : null,
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

    public function versionSummary(): array
    {
        return $this->versionSnapshot();
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
