<?php

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Support\Timestamp;
use DateTimeImmutable;
use App\Services\WrapperService;

class AuthService
{
    private const INACTIVITY_WINDOW_DAYS = 30;
    private const VERSION_CACHE_TTL_SECONDS = 10800; // 3 hours
    private const MIN_LAST_REFRESH_EPOCH = 946684800; // 2000-01-01T00:00:00Z
    private const MAX_FUTURE_SKEW_SECONDS = 300; // allow small clock drift

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly AuthPayloadRepository $payloads,
        private readonly HostAuthStateRepository $hostStates,
        private readonly HostAuthDigestRepository $digests,
        private readonly LogRepository $logs,
        private readonly TokenUsageRepository $tokenUsages,
        private readonly VersionRepository $versions,
        private readonly string $invitationKey,
        private readonly WrapperService $wrapperService
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
            return $payload;
        }

        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create($fqdn, $apiKey);
        $this->logs->log((int) $host['id'], 'register', ['result' => 'created']);

        $payload = $this->buildHostPayload($host, true);
        // status report deprecated

        return $payload;
    }

    public function authenticate(?string $apiKey, ?string $ip = null, bool $allowIpBypass = false): array
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

        $hostId = (int) $host['id'];
        $allowsRoaming = isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false;

        if ($ip !== null && $ip !== '') {
            $storedIp = $host['ip'] ?? null;
            if ($storedIp === null || $storedIp === '') {
                $this->hosts->updateIp($hostId, $ip);
                $this->logs->log($hostId, 'auth.bind_ip', ['ip' => $ip]);
                $host = $this->hosts->findById($hostId) ?? $host;
            } elseif (!hash_equals($storedIp, $ip)) {
                if ($allowsRoaming) {
                    $this->hosts->updateIp($hostId, $ip);
                    $this->logs->log($hostId, 'auth.roaming_ip', [
                        'previous_ip' => $storedIp,
                        'ip' => $ip,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                } elseif ($allowIpBypass) {
                    $this->hosts->updateIp($hostId, $ip);
                    $this->logs->log($hostId, 'auth.force_ip_override', [
                        'previous_ip' => $storedIp,
                        'ip' => $ip,
                    ]);
                    $host = $this->hosts->findById($hostId) ?? $host;
                } else {
                    throw new HttpException('API key not allowed from this IP', 403, [
                        'expected_ip' => $storedIp,
                        'received_ip' => $ip,
                    ]);
                }
            }
        }

        return $host;
    }

    public function handleAuth(array $payload, array $host, ?string $clientVersion, ?string $wrapperVersion = null): array
    {
        [$normalizedClientVersion, $normalizedWrapperVersion] = $this->normalizeVersions($clientVersion, $wrapperVersion);

        $command = $this->normalizeCommand($payload['command'] ?? null);

        $hostId = (int) $host['id'];

        $this->hosts->updateClientVersions($hostId, $normalizedClientVersion, $normalizedWrapperVersion);
        $this->hosts->incrementApiCalls($hostId);
        $host = $this->hosts->findById($hostId) ?? $host;

        $canonicalPayload = $this->resolveCanonicalPayload();
        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;

        $recentDigests = $this->digests->recentDigests($hostId);
        if ($canonicalDigest !== null && !in_array($canonicalDigest, $recentDigests, true)) {
            $this->digests->rememberDigests($hostId, [$canonicalDigest]);
            $recentDigests = $this->digests->recentDigests($hostId);
        }

        $versions = $this->versionSnapshot();

        if ($command === 'retrieve') {
            $providedDigest = $this->extractDigest($payload, true);
            $incomingLastRefresh = $this->extractLastRefresh($payload, 'last_refresh');
            $this->assertReasonableLastRefresh($incomingLastRefresh, 'last_refresh');

            $status = 'missing';
            $response = [
                'status' => $status,
                'canonical_last_refresh' => $canonicalLastRefresh,
                'canonical_digest' => $canonicalDigest,
                'action' => 'store',
                'api_calls' => (int) ($host['api_calls'] ?? 0),
                'versions' => $versions,
            ];

            if ($canonicalPayload) {
                $comparison = Timestamp::compare($incomingLastRefresh, $canonicalLastRefresh);
                $matchesCanonical = $providedDigest !== null && $canonicalDigest !== null && hash_equals($canonicalDigest, $providedDigest);
                $matchesRecent = $providedDigest !== null && in_array($providedDigest, $recentDigests, true);

                if ($matchesCanonical) {
                    $status = 'valid';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];

                    $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                    $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                } else {
                    // Always hand back canonical to allow hydration, even if client claims newer.
                    $status = 'outdated';
                    $authArray = $this->buildAuthArrayFromPayload($canonicalPayload);
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'host' => $this->buildHostPayload($host),
                        'auth' => $authArray,
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];

                    $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                    $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                }
            }

            $this->logs->log($hostId, 'auth.retrieve', [
                'status' => $status,
                'incoming_last_refresh' => $incomingLastRefresh,
                'incoming_digest' => $providedDigest,
                'stored_last_refresh' => $canonicalLastRefresh,
                'stored_digest' => $canonicalDigest,
            ]);

            return $response;
        }

        // store command
        $incomingAuth = $this->extractAuthPayload($payload);
        $incomingLastRefresh = $incomingAuth['last_refresh'] ?? null;
        if (!is_string($incomingLastRefresh) || trim($incomingLastRefresh) === '') {
            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
        }
        $this->assertReasonableLastRefresh($incomingLastRefresh, 'auth.last_refresh');

        $entries = $this->normalizeAuthEntries($incomingAuth);
        $canonicalizedAuth = $this->buildAuthArrayFromEntries($incomingLastRefresh, $entries);

        $encodedAuth = json_encode($canonicalizedAuth, JSON_UNESCAPED_SLASHES);
        if ($encodedAuth === false) {
            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
        }

        $incomingDigest = $this->calculateDigest($encodedAuth);
        $this->digests->rememberDigests($hostId, [$incomingDigest]);

        $comparison = $canonicalLastRefresh !== null ? Timestamp::compare($incomingLastRefresh, $canonicalLastRefresh) : 1;
        $shouldUpdate = !$canonicalPayload || $comparison === 1;
        $status = $shouldUpdate ? 'updated' : ($comparison === -1 ? 'outdated' : 'unchanged');

        if ($shouldUpdate) {
            $payloadRow = $this->payloads->create($incomingLastRefresh, $incomingDigest, $hostId, $entries);
            $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
            $canonicalPayload = $payloadRow;
            $canonicalDigest = $incomingDigest;
            $canonicalLastRefresh = $incomingLastRefresh;

            $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $incomingDigest);
            $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
            $host = $this->hosts->findById($hostId) ?? $host;

            $response = [
                'status' => $status,
                'host' => $this->buildHostPayload($host),
                'auth' => $canonicalizedAuth,
                'canonical_last_refresh' => $canonicalLastRefresh,
                'canonical_digest' => $canonicalDigest,
                'api_calls' => (int) ($host['api_calls'] ?? 0),
                'versions' => $versions,
            ];

        } else {
            $host = $this->hosts->findById($hostId) ?? $host;

            if ($status === 'outdated' && $canonicalPayload) {
                $authArray = $this->buildAuthArrayFromPayload($canonicalPayload);
                $response = [
                    'status' => $status,
                    'host' => $this->buildHostPayload($host),
                    'auth' => $authArray,
                    'canonical_last_refresh' => $canonicalLastRefresh,
                    'canonical_digest' => $canonicalDigest,
                    'api_calls' => (int) ($host['api_calls'] ?? 0),
                    'versions' => $versions,
                ];
            } else {
                $response = [
                    'status' => $status,
                    'canonical_last_refresh' => $canonicalLastRefresh,
                    'canonical_digest' => $canonicalDigest,
                    'api_calls' => (int) ($host['api_calls'] ?? 0),
                    'versions' => $versions,
                ];
            }

            if ($canonicalPayload) {
                $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest ?? $incomingDigest);
                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh ?? $incomingLastRefresh, $canonicalDigest ?? $incomingDigest);
            }
        }

        $this->logs->log($hostId, 'auth.store', [
            'status' => $status,
            'incoming_last_refresh' => $incomingLastRefresh,
            'incoming_digest' => $incomingDigest,
            'stored_last_refresh' => $canonicalLastRefresh,
            'stored_digest' => $canonicalDigest,
            'client_version' => $normalizedClientVersion,
            'wrapper_version' => $normalizedWrapperVersion,
        ]);

        return $response;
    }

    public function deleteHost(array $host): array
    {
        if (!isset($host['id'])) {
            throw new HttpException('Host not found', 404);
        }

        $hostId = (int) $host['id'];
        $fqdn = $host['fqdn'] ?? null;

        $this->logs->log($hostId, 'host.delete', [
            'fqdn' => $fqdn,
            'initiator' => 'host_api',
        ]);

        $this->digests->deleteByHostId($hostId);
        $this->hosts->deleteById($hostId);
        // status report deprecated

        return [
            'deleted' => $fqdn,
        ];
    }

    public function recordTokenUsage(array $host, array $payload): array
    {
        if (!isset($host['id'])) {
            throw new HttpException('Host not found', 404);
        }

        $line = '';
        if (array_key_exists('line', $payload) && is_string($payload['line'])) {
            $line = trim($payload['line']);
        }

        $total = $this->normalizeUsageInt($payload['total'] ?? null, 'total');
        $input = $this->normalizeUsageInt($payload['input'] ?? null, 'input');
        $output = $this->normalizeUsageInt($payload['output'] ?? null, 'output');
        $cached = $this->normalizeUsageInt($payload['cached'] ?? null, 'cached', true);
        $model = null;
        if (isset($payload['model']) && is_string($payload['model'])) {
            $model = trim($payload['model']);
        }

        if ($line === '' && $total === null && $input === null && $output === null && $cached === null) {
            throw new ValidationException([
                'line' => ['line or at least one numeric field is required'],
            ]);
        }

        $details = array_filter([
            'line' => $line !== '' ? $line : null,
            'total' => $total,
            'input' => $input,
            'output' => $output,
            'cached' => $cached,
            'model' => $model !== '' ? $model : null,
        ], static fn ($value) => $value !== null);

        $this->tokenUsages->record((int) $host['id'], $total, $input, $output, $cached, $model !== '' ? $model : null, $line !== '' ? $line : null);
        $this->logs->log((int) $host['id'], 'token.usage', $details);

        return array_merge([
            'host_id' => (int) $host['id'],
            'recorded_at' => gmdate(DATE_ATOM),
            'line' => $line !== '' ? $line : null,
            'total' => $total,
            'input' => $input,
            'output' => $output,
            'cached' => $cached,
        ], $model !== null ? ['model' => $model === '' ? null : $model] : []);
    }

    private function versionSnapshot(): array
    {
        $available = $this->availableClientVersion();
        $wrapperMeta = $this->wrapperService->metadata();
        $reported = $this->latestReportedVersions();
        $this->seedWrapperVersionFromReported($reported['wrapper_version']);

        // Only trust GitHub (cached for 3h). If unavailable, client_version will be null.
        $clientVersion = $this->canonicalVersion($available['version'] ?? null);
        $clientCheckedAt = $available['updated_at'] ?? null;
        $clientSource = $available['source'] ?? null;

        $published = $this->publishedVersions();
        // Wrapper: take the highest of stored metadata, published, or reported.
        $wrapperCandidates = [];
        foreach ([
            ['version' => $wrapperMeta['version'] ?? null, 'source' => 'stored'],
            ['version' => $published['wrapper_version'] ?? null, 'source' => 'published'],
            ['version' => $reported['wrapper_version'] ?? null, 'source' => 'reported'],
        ] as $candidate) {
            if (empty($candidate['version'])) {
                continue;
            }
            $wrapperCandidates[] = $candidate;
        }

        $wrapperVersion = null;
        if ($wrapperCandidates) {
            $wrapperVersion = $wrapperCandidates[0]['version'];
            foreach ($wrapperCandidates as $candidate) {
                if ($this->isVersionGreater((string) $candidate['version'], (string) $wrapperVersion)) {
                    $wrapperVersion = $candidate['version'];
                }
            }
        }

        return [
            'client_version' => $clientVersion,
            'client_version_checked_at' => $clientCheckedAt,
            'client_version_source' => $clientSource,
            'wrapper_version' => $wrapperVersion,
            'wrapper_sha256' => $wrapperMeta['sha256'] ?? null,
            'wrapper_url' => $wrapperMeta['url'] ?? null,
            'reported_client_version' => $reported['client_version'],
            'reported_wrapper_version' => $reported['wrapper_version'],
        ];
    }

    private function normalizeUsageInt(mixed $value, string $field, bool $optional = false): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (is_int($value)) {
            if ($value < 0) {
                throw new ValidationException([$field => [$field . ' must be non-negative']]);
            }

            return $value;
        }

        if (is_numeric($value)) {
            $intVal = (int) $value;
            if ($intVal < 0) {
                throw new ValidationException([$field => [$field . ' must be non-negative']]);
            }

            return $intVal;
        }

        if ($optional) {
            return null;
        }

        throw new ValidationException([$field => [$field . ' must be an integer']]);
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

    private function assertReasonableLastRefresh(string $value, string $field): void
    {
        try {
            $dt = new DateTimeImmutable($value);
        } catch (\Exception) {
            throw new ValidationException([$field => ['must be an RFC3339 timestamp']]);
        }

        $ts = $dt->getTimestamp();
        $now = time();

        if ($ts < self::MIN_LAST_REFRESH_EPOCH) {
            throw new ValidationException([$field => ['timestamp is implausibly old']]);
        }

        if ($ts > ($now + self::MAX_FUTURE_SKEW_SECONDS)) {
            throw new ValidationException([$field => ['timestamp is in the future']]);
        }
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
            'allow_roaming_ips' => isset($host['allow_roaming_ips']) ? (bool) (int) $host['allow_roaming_ips'] : false,
        ];

        if ($includeApiKey) {
            $payload['api_key'] = $host['api_key'];
        }

        return $payload;
    }

    private function normalizeAuthEntries(array $authPayload): array
    {
        if (!isset($authPayload['auths']) || !is_array($authPayload['auths'])) {
            throw new ValidationException(['auth.auths' => ['auths must be an object of targets']]);
        }

        if ($authPayload['auths'] === [] || count($authPayload['auths']) === 0) {
            throw new ValidationException(['auth.auths' => ['auths must contain at least one entry']]);
        }

        $entries = [];
        foreach ($authPayload['auths'] as $target => $entry) {
            if (!is_string($target) || trim($target) === '') {
                throw new ValidationException(['auth.auths' => ['auths keys must be non-empty strings']]);
            }
            if (!is_array($entry)) {
                throw new ValidationException(['auth.auths.' . $target => ['entry must be an object']]);
            }

            $token = $entry['token'] ?? null;
            if (!is_string($token) || trim($token) === '') {
                throw new ValidationException(['auth.auths.' . $target . '.token' => ['token is required']]);
            }
            if (strlen($token) < 20 || in_array($token, ['token', 'newer-token'], true)) {
                throw new ValidationException(['auth.auths.' . $target . '.token' => ['token looks invalid or placeholder']]);
            }

            $tokenType = $entry['token_type'] ?? ($entry['type'] ?? 'bearer');
            $organization = $entry['organization'] ?? ($entry['org'] ?? ($entry['default_organization'] ?? ($entry['default_org'] ?? null)));
            $project = $entry['project'] ?? ($entry['default_project'] ?? null);
            $apiBase = $entry['api_base'] ?? ($entry['base_url'] ?? null);

            $meta = [];
            foreach ($entry as $key => $value) {
                if (in_array($key, ['token', 'token_type', 'type', 'organization', 'org', 'default_organization', 'default_org', 'project', 'default_project', 'api_base', 'base_url'], true)) {
                    continue;
                }
                if (is_scalar($value) || $value === null) {
                    $meta[$key] = $value;
                }
            }

            $entries[] = [
                'target' => trim($target),
                'token' => trim($token),
                'token_type' => is_string($tokenType) && trim($tokenType) !== '' ? trim($tokenType) : 'bearer',
                'organization' => is_string($organization) && trim($organization) !== '' ? trim($organization) : null,
                'project' => is_string($project) && trim($project) !== '' ? trim($project) : null,
                'api_base' => is_string($apiBase) && trim($apiBase) !== '' ? trim($apiBase) : null,
                'meta' => $meta ?: null,
            ];
        }

        return $entries;
    }

    private function buildAuthArrayFromEntries(string $lastRefresh, array $entries): array
    {
        $auths = [];

        foreach ($entries as $entry) {
            $item = ['token' => $entry['token']];
            if (isset($entry['token_type']) && $entry['token_type'] !== null) {
                $item['token_type'] = $entry['token_type'];
            }
            if (isset($entry['organization']) && $entry['organization'] !== null) {
                $item['organization'] = $entry['organization'];
            }
            if (isset($entry['project']) && $entry['project'] !== null) {
                $item['project'] = $entry['project'];
            }
            if (isset($entry['api_base']) && $entry['api_base'] !== null) {
                $item['api_base'] = $entry['api_base'];
            }
            if (!empty($entry['meta']) && is_array($entry['meta'])) {
                foreach ($entry['meta'] as $key => $value) {
                    $item[$key] = $value;
                }
            }

            ksort($item);
            $auths[$entry['target']] = $item;
        }

        ksort($auths);

        return [
            'last_refresh' => $lastRefresh,
            'auths' => $auths,
        ];
    }

    private function buildAuthArrayFromPayload(array $payload): array
    {
        $lastRefresh = $payload['last_refresh'] ?? '';
        $entries = $payload['entries'] ?? [];

        return $this->buildAuthArrayFromEntries($lastRefresh, $entries);
    }

    private function resolveCanonicalPayload(): ?array
    {
        $id = $this->versions->get('canonical_payload_id');
        if ($id !== null && ctype_digit((string) $id)) {
            $payload = $this->payloads->findByIdWithEntries((int) $id);
            if ($payload) {
                return $payload;
            }
        }

        return $this->payloads->latest();
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
            'client_version' => $this->canonicalVersion($latestClient),
            'wrapper_version' => $this->canonicalVersion($latestWrapper),
        ];
    }

    public function versionSummary(): array
    {
        return $this->versionSnapshot();
    }

    public function availableClientVersion(bool $forceRefresh = false): array
    {
        // 1) Prefer published (admin-set) version if present.
        $published = $this->versions->get('client');
        if ($published !== null && $published !== '') {
            $normalized = $this->canonicalVersion($published) ?? $published;
            return [
                'version' => $normalized,
                'updated_at' => gmdate(DATE_ATOM),
                'source' => 'published',
            ];
        }

        $cached = $this->versions->getWithMetadata('client_available');
        $now = time();
        $cacheFresh = false;

        if (!$forceRefresh && $cached && isset($cached['updated_at'])) {
            $updatedAt = strtotime($cached['updated_at']);
            if ($updatedAt !== false && ($now - $updatedAt) <= self::VERSION_CACHE_TTL_SECONDS) {
                $cacheFresh = true;
            }
        }

        $cachedVersion = $this->canonicalVersion($cached['version'] ?? null);

        if ($cacheFresh && $cachedVersion !== null) {
            return [
                'version' => $cachedVersion,
                'updated_at' => $cached['updated_at'] ?? null,
                'source' => 'cache',
            ];
        }

        $fetched = $this->fetchLatestCodexVersion();
        if ($fetched !== null) {
            $normalized = $this->canonicalVersion($fetched) ?? $fetched;
            $this->versions->set('client_available', $normalized);
            return [
                'version' => $normalized,
                'updated_at' => gmdate(DATE_ATOM),
                'source' => 'github',
            ];
        }

        if ($cachedVersion !== null) {
            return [
                'version' => $cachedVersion,
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
            $normalizedClient = $this->canonicalVersion($clientVersion);
            $this->versions->set('client', $normalizedClient ?? trim($clientVersion));
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
    }

    /**
     * @return array{0:string,1:?string}
     */
    private function normalizeVersions(?string $clientVersion, ?string $wrapperVersion): array
    {
        $normalizedClientVersion = $this->canonicalVersion(is_string($clientVersion) ? $clientVersion : '');
        if ($normalizedClientVersion === null || $normalizedClientVersion === '') {
            $normalizedClientVersion = 'unknown';
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
        $left = $this->normalizeVersionString($left);
        $right = $this->normalizeVersionString($right);

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
                $normalized = $this->canonicalVersion($candidate);
                if ($normalized !== null && $normalized !== '') {
                    return $normalized;
                }
            }
        }

        return null;
    }

    private function normalizeVersionString(string $value): string
    {
        $normalized = trim($value);
        $normalized = preg_replace('/^(codex-cli|codex|rust-)/i', '', $normalized) ?? $normalized;
        $normalized = ltrim($normalized, 'vV');

        return $normalized;
    }

    private function canonicalVersion(?string $value): ?string
    {
        if (!is_string($value)) {
            return null;
        }

        $normalized = $this->normalizeVersionString($value);

        return $normalized === '' ? null : $normalized;
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
