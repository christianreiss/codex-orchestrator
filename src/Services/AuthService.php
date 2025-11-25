<?php

namespace App\Services;

use App\Config;
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
use App\Services\RunnerVerifier;

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
        private readonly WrapperService $wrapperService,
        private readonly ?RunnerVerifier $runnerVerifier = null
    ) {
    }

    public function register(string $fqdn): array
    {
        $this->pruneInactiveHosts();

        $errors = [];
        if ($fqdn === '') {
            $errors['fqdn'][] = 'FQDN is required';
        }

        if ($errors) {
            throw new ValidationException($errors);
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
                } elseif ($this->shouldAllowRunnerIpBypass($ip)) {
                    // Runner needs to validate auth without rebinding host IP; do not update stored IP.
                    $this->logs->log($hostId, 'auth.runner_ip_bypass', [
                        'expected_ip' => $storedIp,
                        'ip' => $ip,
                    ]);
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

    public function handleAuth(array $payload, array $host, ?string $clientVersion, ?string $wrapperVersion = null, ?string $baseUrl = null): array
    {
        [$normalizedClientVersion, $normalizedWrapperVersion] = $this->normalizeVersions($clientVersion, $wrapperVersion);

        $command = $this->normalizeCommand($payload['command'] ?? null);

        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : 0;
        $trackHost = $hostId > 0;
        $logHostId = $trackHost ? $hostId : null;

        if ($trackHost) {
            $this->hosts->updateClientVersions($hostId, $normalizedClientVersion, $normalizedWrapperVersion);
            $this->hosts->incrementApiCalls($hostId);
            $host = $this->hosts->findById($hostId) ?? $host;
        }

        $bakedWrapperMeta = null;
        if ($trackHost && $baseUrl !== null && $baseUrl !== '') {
            $bakedWrapperMeta = $this->wrapperService->bakedForHost($host, $baseUrl);
        }

        $versions = $this->versionSnapshot($bakedWrapperMeta);
        $canonicalPayload = $this->resolveCanonicalPayload();
        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;
        $canonicalAuthArray = null;

        if ($canonicalPayload !== null) {
            $validated = $this->validateCanonicalPayload($canonicalPayload);
            if ($validated !== null) {
                $canonicalAuthArray = $validated['auth'];
                $canonicalDigest = $validated['digest'];
                $canonicalLastRefresh = $validated['last_refresh'];
            } else {
                $canonicalPayload = null;
                $canonicalDigest = null;
                $canonicalLastRefresh = null;
            }
        }

        // Daily runner preflight: once per UTC day, refresh canonical via runner before responding.
        if ($this->runnerVerifier !== null) {
            [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh] = $this->runnerDailyCheck($canonicalPayload, $host, $versions);
            if ($canonicalPayload !== null) {
                $validated = $this->validateCanonicalPayload($canonicalPayload);
                if ($validated !== null) {
                    $canonicalAuthArray = $validated['auth'];
                    $canonicalDigest = $validated['digest'];
                    $canonicalLastRefresh = $validated['last_refresh'];
                } else {
                    $canonicalPayload = null;
                    $canonicalAuthArray = null;
                    $canonicalDigest = null;
                    $canonicalLastRefresh = null;
                }
            } else {
                $canonicalAuthArray = null;
            }
        }

        $recentDigests = $trackHost ? $this->digests->recentDigests($hostId) : [];
        if ($trackHost && $canonicalDigest !== null && !in_array($canonicalDigest, $recentDigests, true)) {
            $this->digests->rememberDigests($hostId, [$canonicalDigest]);
            $recentDigests = $this->digests->recentDigests($hostId);
        }

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

                if ($matchesCanonical) {
                    $status = 'valid';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                        $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                    }
                } elseif ($comparison === 1) {
                    // Client claims a newer payload; ask it to upload.
                    $status = 'upload_required';
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'action' => 'store',
                        'versions' => $versions,
                    ];

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                        $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                    }
                } else {
                    // Always hand back canonical to allow hydration, even if client claims newer.
                    $status = 'outdated';
                    $authArray = $canonicalAuthArray ?? $this->canonicalAuthFromPayload($canonicalPayload);
                    $response = [
                        'status' => $status,
                        'canonical_last_refresh' => $canonicalLastRefresh,
                        'canonical_digest' => $canonicalDigest,
                        'host' => $trackHost ? $this->buildHostPayload($host) : null,
                        'auth' => $authArray,
                        'api_calls' => (int) ($host['api_calls'] ?? 0),
                        'versions' => $versions,
                    ];

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest);
                        $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                    }
                }
            }

            $this->logs->log($logHostId, 'auth.retrieve', [
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

        $incomingAuth = $this->ensureAuthsFallback($incomingAuth);
        $entries = $this->normalizeAuthEntries($incomingAuth);
        $canonicalizedAuth = $this->canonicalizeAuthPayload($incomingAuth, $entries, $incomingLastRefresh);

        $encodedAuth = json_encode($canonicalizedAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encodedAuth === false) {
            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
        }

        $incomingDigest = $this->calculateDigest($encodedAuth);
        if ($trackHost) {
            $this->digests->rememberDigests($hostId, [$incomingDigest]);
        }

        $comparison = $canonicalLastRefresh !== null ? Timestamp::compare($incomingLastRefresh, $canonicalLastRefresh) : 1;
        $shouldUpdate = !$canonicalPayload || $comparison === 1;
        $status = $shouldUpdate ? 'updated' : ($comparison === -1 ? 'outdated' : 'unchanged');

        if ($shouldUpdate) {
            // Persist normalized entries alongside the raw canonical body so older callers can still rehydrate.
            $payloadRow = $this->payloads->create($incomingLastRefresh, $incomingDigest, $trackHost ? $hostId : null, $entries, $encodedAuth);
            $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
            $canonicalPayload = $payloadRow;
            $canonicalDigest = $incomingDigest;
            $canonicalLastRefresh = $incomingLastRefresh;

            if ($trackHost) {
                $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $incomingDigest);
                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                $host = $this->hosts->findById($hostId) ?? $host;
            }

            $response = [
                'status' => $status,
                'auth' => $canonicalizedAuth,
                'canonical_last_refresh' => $canonicalLastRefresh,
                'canonical_digest' => $canonicalDigest,
                'api_calls' => (int) ($host['api_calls'] ?? 0),
                'versions' => $versions,
            ];
            if ($trackHost) {
                $response['host'] = $this->buildHostPayload($host);
            }

        } else {
            $host = $trackHost ? ($this->hosts->findById($hostId) ?? $host) : $host;

            if ($status === 'outdated' && $canonicalPayload) {
                $authArray = $canonicalAuthArray ?? $this->canonicalAuthFromPayload($canonicalPayload);
                $response = [
                    'status' => $status,
                    'auth' => $authArray,
                    'canonical_last_refresh' => $canonicalLastRefresh,
                    'canonical_digest' => $canonicalDigest,
                    'api_calls' => (int) ($host['api_calls'] ?? 0),
                    'versions' => $versions,
                ];
                if ($trackHost) {
                    $response['host'] = $this->buildHostPayload($host);
                }
            } else {
                $response = [
                    'status' => $status,
                    'canonical_last_refresh' => $canonicalLastRefresh,
                    'canonical_digest' => $canonicalDigest,
                    'api_calls' => (int) ($host['api_calls'] ?? 0),
                    'versions' => $versions,
                ];
            }

            if ($trackHost && $canonicalPayload) {
                $this->hostStates->upsert($hostId, (int) $canonicalPayload['id'], $canonicalDigest ?? $incomingDigest);
                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh ?? $incomingLastRefresh, $canonicalDigest ?? $incomingDigest);
            }
        }

        $this->logs->log($logHostId, 'auth.store', [
            'status' => $status,
            'incoming_last_refresh' => $incomingLastRefresh,
            'incoming_digest' => $incomingDigest,
            'stored_last_refresh' => $canonicalLastRefresh,
            'stored_digest' => $canonicalDigest,
            'client_version' => $normalizedClientVersion,
            'wrapper_version' => $normalizedWrapperVersion,
        ]);

        $validation = null;
        $runnerApplied = false;
        if ($this->runnerVerifier !== null) {
            $authToValidate = null;
            if ($canonicalPayload) {
                $authToValidate = $canonicalAuthArray ?? $this->canonicalAuthFromPayload($canonicalPayload);
            } elseif ($canonicalizedAuth !== null) {
                $authToValidate = $canonicalizedAuth;
            }

            if ($authToValidate !== null) {
                $validation = $this->runnerVerifier->verify($authToValidate);
                $this->logs->log($logHostId, 'auth.validate', [
                    'status' => $validation['status'] ?? null,
                    'reason' => $validation['reason'] ?? null,
                    'latency_ms' => $validation['latency_ms'] ?? null,
                ]);

                if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
                    try {
                        $runnerAuth = $validation['updated_auth'];
                        $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                        if (!is_string($runnerLastRefresh) || trim($runnerLastRefresh) === '') {
                            throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
                        }
                        $this->assertReasonableLastRefresh($runnerLastRefresh, 'auth.last_refresh');
                        $runnerAuth = $this->ensureAuthsFallback($runnerAuth);
                        $runnerEntries = $this->normalizeAuthEntries($runnerAuth);
                        $runnerCanonical = $this->canonicalizeAuthPayload($runnerAuth, $runnerEntries, $runnerLastRefresh);
                        $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                        if ($runnerEncoded === false) {
                            throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
                        }
                        $runnerDigest = $this->calculateDigest($runnerEncoded);
                        $comparisonRunner = $canonicalLastRefresh !== null ? Timestamp::compare($runnerLastRefresh, $canonicalLastRefresh) : 1;
                        $runnerShouldUpdate = $canonicalPayload === null
                            || $comparisonRunner === 1
                            || ($comparisonRunner === 0 && $runnerDigest !== $canonicalDigest);

                        if ($runnerShouldUpdate) {
                            $payloadRow = $this->payloads->create($runnerLastRefresh, $runnerDigest, $trackHost ? $hostId : null, $runnerEntries, $runnerEncoded);
                            $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
                            $canonicalPayload = $payloadRow;
                            $canonicalDigest = $runnerDigest;
                            $canonicalLastRefresh = $runnerLastRefresh;

                            if ($trackHost) {
                                $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $runnerDigest);
                                $this->hosts->updateSyncState($hostId, $canonicalLastRefresh, $canonicalDigest);
                                $host = $this->hosts->findById($hostId) ?? $host;
                            }

                            $response = [
                                'status' => 'updated',
                                'auth' => $this->canonicalAuthFromPayload($canonicalPayload),
                                'canonical_last_refresh' => $canonicalLastRefresh,
                                'canonical_digest' => $canonicalDigest,
                                'api_calls' => (int) ($host['api_calls'] ?? 0),
                                'versions' => $versions,
                            ];
                            if ($trackHost) {
                                $response['host'] = $this->buildHostPayload($host);
                            }
                            $runnerApplied = true;
                            $this->logs->log($logHostId, 'auth.runner_store', [
                                'status' => 'applied',
                                'incoming_last_refresh' => $runnerLastRefresh,
                                'incoming_digest' => $runnerDigest,
                            ]);
                        } else {
                            $this->logs->log($logHostId, 'auth.runner_store', [
                                'status' => 'skipped',
                                'reason' => 'runner auth not newer or identical',
                                'incoming_last_refresh' => $runnerLastRefresh,
                                'incoming_digest' => $runnerDigest,
                                'stored_last_refresh' => $canonicalLastRefresh,
                                'stored_digest' => $canonicalDigest,
                            ]);
                        }
                    } catch (\Throwable $exception) {
                        $this->logs->log($logHostId, 'auth.runner_store', [
                            'status' => 'failed',
                            'reason' => $exception->getMessage(),
                        ]);
                    }
                }
            }
        }

        if ($validation !== null) {
            $response['validation'] = $validation;
        }
        if ($runnerApplied) {
            $response['runner_applied'] = true;
        }

        if ($validation !== null) {
            $response['validation'] = $validation;
        }
        $response['runner_applied'] = $runnerApplied;

        return $response;
    }

    /**
     * Run the runner against the current canonical auth (daily or manual).
     *
     * @param bool $forceRun When true, bypass the once-per-day guard (used for manual admin trigger).
     * @param string $trigger Label for log records.
     *
     * @return array{0: ?array, 1: ?string, 2: ?string} Updated canonical payload, digest, last_refresh
     */
    private function runnerDailyCheck(?array $canonicalPayload, array $host, array $versions, bool $forceRun = false, string $trigger = 'daily_preflight'): array
    {
        if ($canonicalPayload === null || $this->runnerVerifier === null) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        $validatedCanonical = $this->validateCanonicalPayload($canonicalPayload);
        if ($validatedCanonical === null) {
            return [null, null, null];
        }

        $canonicalAuth = $validatedCanonical['auth'];
        $currentDigest = $validatedCanonical['digest'];
        $currentLastRefresh = $validatedCanonical['last_refresh'];

        $today = gmdate('Y-m-d');
        $lastCheck = $this->versions->get('runner_last_check', '');
        if (!$forceRun && $lastCheck === $today) {
            return [$canonicalPayload, $currentDigest, $currentLastRefresh];
        }

        $hostId = (int) ($host['id'] ?? 0);
        $trackHost = $hostId > 0;
        $logHostId = $trackHost ? $hostId : null;
        try {
            $validation = $this->runnerVerifier->verify($canonicalAuth, null, null, $host);
            $this->logs->log($logHostId, 'auth.validate', [
                'status' => $validation['status'] ?? null,
                'reason' => $validation['reason'] ?? null,
                'latency_ms' => $validation['latency_ms'] ?? null,
                'trigger' => $trigger,
            ]);

            if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
                $runnerAuth = $validation['updated_auth'];
                $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                $this->assertReasonableLastRefresh((string) $runnerLastRefresh, 'auth.last_refresh');
                $runnerAuth = $this->ensureAuthsFallback($runnerAuth);
                $runnerEntries = $this->normalizeAuthEntries($runnerAuth);
                $runnerCanonical = $this->canonicalizeAuthPayload($runnerAuth, $runnerEntries, (string) $runnerLastRefresh);
                $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                if ($runnerEncoded === false) {
                    throw new ValidationException(['auth' => ['Unable to encode runner auth payload']]);
                }
                $runnerDigest = $this->calculateDigest($runnerEncoded);

                $comparison = $currentLastRefresh !== null
                    ? Timestamp::compare((string) $runnerLastRefresh, $currentLastRefresh)
                    : 1;

                $shouldUpdate = $canonicalPayload === null
                    || $comparison === 1
                    || ($comparison === 0 && $runnerDigest !== $currentDigest);

                if ($shouldUpdate) {
                    $payloadRow = $this->payloads->create((string) $runnerLastRefresh, $runnerDigest, $trackHost ? $hostId : null, $runnerEntries, $runnerEncoded);
                    $this->versions->set('canonical_payload_id', (string) $payloadRow['id']);
                    $canonicalPayload = $payloadRow;

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $runnerDigest);
                        $this->hosts->updateSyncState($hostId, (string) $runnerLastRefresh, $runnerDigest);
                    }
                    $this->logs->log($logHostId, 'auth.runner_store', [
                        'status' => 'applied',
                        'trigger' => $trigger,
                        'incoming_last_refresh' => $runnerLastRefresh,
                        'incoming_digest' => $runnerDigest,
                    ]);
                } else {
                    $this->logs->log($logHostId, 'auth.runner_store', [
                        'status' => 'skipped',
                        'trigger' => $trigger,
                        'reason' => 'runner auth not newer or identical',
                    ]);
                }
            }
        } catch (\Throwable $exception) {
            $this->logs->log($logHostId, 'auth.runner_store', [
                'status' => 'failed',
                'trigger' => $trigger,
                'reason' => $exception->getMessage(),
            ]);
        } finally {
            $this->versions->set('runner_last_check', $today);
        }

        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;
        return [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh];
    }

    public function triggerRunnerRefresh(): array
    {
        if ($this->runnerVerifier === null) {
            throw new HttpException('Runner not configured', 503);
        }

        $canonicalPayload = $this->resolveCanonicalPayload();
        if ($canonicalPayload === null) {
            throw new HttpException('No canonical auth payload available', 404);
        }

        $host = null;
        if (isset($canonicalPayload['source_host_id'])) {
            $host = $this->hosts->findById((int) $canonicalPayload['source_host_id']);
        }
        if ($host === null) {
            $hosts = $this->hosts->all();
            $host = $hosts[0] ?? null;
        }
        if ($host === null) {
            throw new HttpException('No host available to tag runner logs', 404);
        }

        $versions = $this->versionSnapshot();
        $originalDigest = $canonicalPayload['sha256'] ?? null;

        [$updatedPayload, $newDigest, $newLastRefresh] = $this->runnerDailyCheck(
            $canonicalPayload,
            $host,
            $versions,
            true,
            'manual'
        );

        $applied = $newDigest !== null && $newDigest !== $originalDigest;

        return [
            'applied' => $applied,
            'canonical_digest' => $newDigest,
            'canonical_last_refresh' => $newLastRefresh,
            'runner_last_check' => $this->versions->get('runner_last_check', null),
        ];
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

    private function versionSnapshot(?array $wrapperMetaOverride = null): array
    {
        $available = $this->availableClientVersion();
        $wrapperMeta = $wrapperMetaOverride ?? $this->wrapperService->metadata();
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

    private function ensureAuthsFallback(array $authPayload): array
    {
        $hasAuths = isset($authPayload['auths']) && is_array($authPayload['auths']) && count($authPayload['auths']) > 0;
        if ($hasAuths) {
            return $authPayload;
        }

        $tokenCandidates = [];
        if (isset($authPayload['tokens']) && is_array($authPayload['tokens'])) {
            $tokenCandidates[] = $authPayload['tokens']['access_token'] ?? null;
        }
        if (isset($authPayload['OPENAI_API_KEY'])) {
            $tokenCandidates[] = $authPayload['OPENAI_API_KEY'];
        }

        $chosen = null;
        foreach ($tokenCandidates as $candidate) {
            if (is_string($candidate) && trim($candidate) !== '') {
                $chosen = trim($candidate);
                break;
            }
        }

        if ($chosen === null) {
            return $authPayload;
        }

        $authPayload['auths'] = [
            'api.openai.com' => [
                'token' => $chosen,
                'token_type' => 'bearer',
            ],
        ];

        return $authPayload;
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

    private function sortRecursive(mixed $value): mixed
    {
        if (!is_array($value)) {
            return $value;
        }

        $isAssoc = array_keys($value) !== range(0, count($value) - 1);
        if ($isAssoc) {
            ksort($value);
        }

        foreach ($value as $k => $v) {
            $value[$k] = $this->sortRecursive($v);
        }

        return $value;
    }

    private function canonicalizeAuthPayload(array $incomingAuth, array $entries, string $incomingLastRefresh): array
    {
        $normalized = $incomingAuth;
        $normalized['last_refresh'] = $incomingLastRefresh;
        $normalized['auths'] = $this->buildAuthArrayFromEntries($incomingLastRefresh, $entries)['auths'];

        return $normalized;
    }

    private function canonicalAuthFromPayload(array $payload): array
    {
        if (isset($payload['body']) && is_string($payload['body']) && $payload['body'] !== '') {
            $decoded = json_decode($payload['body'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return $this->buildAuthArrayFromPayload($payload);
    }

    public function validateCanonicalPayload(?array $payload): ?array
    {
        if ($payload === null) {
            return null;
        }

        try {
            $auth = $this->canonicalAuthFromPayload($payload);
            $lastRefresh = $auth['last_refresh'] ?? null;
            if (!is_string($lastRefresh) || trim($lastRefresh) === '') {
                throw new ValidationException(['auth.last_refresh' => ['last_refresh is required']]);
            }
            $this->assertReasonableLastRefresh($lastRefresh, 'auth.last_refresh');
            $this->normalizeAuthEntries($auth);

            $encoded = json_encode($auth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
            if ($encoded === false) {
                throw new ValidationException(['auth' => ['Unable to encode auth payload']]);
            }
            $digest = $this->calculateDigest($encoded);
            $storedDigest = $payload['sha256'] ?? null;
            if (is_string($storedDigest) && $storedDigest !== '' && !hash_equals($storedDigest, $digest)) {
                throw new ValidationException(['auth.digest' => ['stored digest mismatch']]);
            }

            return [
                'auth' => $auth,
                'digest' => $digest,
                'last_refresh' => $lastRefresh,
                'encoded' => $encoded,
            ];
        } catch (\Throwable $exception) {
            $this->logs->log(
                isset($payload['source_host_id']) ? (int) $payload['source_host_id'] : null,
                'auth.canonical_invalid',
                [
                    'payload_id' => $payload['id'] ?? null,
                    'reason' => $exception->getMessage(),
                ]
            );

            return null;
        }
    }

    private function normalizeAuthEntries(array $authPayload): array
    {
        // Allow fallback when auths are missing or empty but a tokens-style access token exists.
        if (!isset($authPayload['auths']) || !is_array($authPayload['auths']) || count($authPayload['auths']) === 0) {
            $fallbackToken = null;
            if (isset($authPayload['tokens']['access_token']) && is_string($authPayload['tokens']['access_token'])) {
                $fallbackToken = trim($authPayload['tokens']['access_token']);
            } elseif (isset($authPayload['OPENAI_API_KEY']) && is_string($authPayload['OPENAI_API_KEY'])) {
                $fallbackToken = trim($authPayload['OPENAI_API_KEY']);
            }

            if ($fallbackToken !== null && $fallbackToken !== '') {
                // Default target mirrors Codex endpoints; keeps behavior deterministic.
                $authPayload['auths'] = [
                    'api.openai.com' => [
                        'token' => $fallbackToken,
                    ],
                ];
            } else {
                throw new ValidationException(['auth.auths' => ['auths must be an object of targets']]);
            }
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
            $token = trim($token);
            $this->assertTokenQuality($token, $target);

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

    private function assertTokenQuality(string $token, string $target): void
    {
        $minLength = (int) (Config::get('TOKEN_MIN_LENGTH', 24));
        if ($minLength < 8) {
            $minLength = 8;
        }

        if (preg_match('/\s/', $token)) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token may not contain whitespace or newlines']]);
        }

        if (strlen($token) < $minLength) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ["token too short (min {$minLength} characters)"]]);
        }

        $lower = strtolower($token);
        $placeholders = ['token', 'newer-token', 'placeholder', 'changeme', 'dummy', 'test', 'example', 'example-token'];
        if (in_array($lower, $placeholders, true)) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token appears to be a placeholder value']]);
        }

        if (preg_match('/^(.)\1+$/', $token)) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token is not high-entropy (single repeated character)']]);
        }

        $uniqueChars = count(array_unique(str_split($token)));
        if ($uniqueChars < 6) {
            throw new ValidationException(['auth.auths.' . $target . '.token' => ['token entropy too low (too few unique characters)']]);
        }
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

    private function shouldAllowRunnerIpBypass(string $ip): bool
    {
        $enabledRaw = Config::get('AUTH_RUNNER_IP_BYPASS', '0');
        $enabled = in_array(strtolower((string) $enabledRaw), ['1', 'true', 'yes', 'on'], true);
        if (!$enabled) {
            return false;
        }

        $subnetsRaw = Config::get('AUTH_RUNNER_BYPASS_SUBNETS', '');
        $subnets = array_filter(array_map('trim', explode(',', (string) $subnetsRaw)));
        if (!$subnets) {
            return false;
        }

        foreach ($subnets as $subnet) {
            if ($this->ipInCidr($ip, $subnet)) {
                return true;
            }
        }

        return false;
    }

    private function ipInCidr(string $ip, string $cidr): bool
    {
        if (!str_contains($cidr, '/')) {
            return false;
        }

        [$network, $mask] = explode('/', $cidr, 2);
        $maskLength = (int) $mask;

        $ipBin = @inet_pton($ip);
        $netBin = @inet_pton($network);

        if ($ipBin === false || $netBin === false || strlen($ipBin) !== strlen($netBin)) {
            return false;
        }

        $bits = strlen($ipBin) * 8;
        if ($maskLength < 0 || $maskLength > $bits) {
            return false;
        }

        $bytes = intdiv($maskLength, 8);
        $remainder = $maskLength % 8;

        if ($bytes && substr($ipBin, 0, $bytes) !== substr($netBin, 0, $bytes)) {
            return false;
        }

        if ($remainder === 0) {
            return true;
        }

        $maskByte = chr(0xFF << (8 - $remainder) & 0xFF);
        return (ord($ipBin[$bytes]) & ord($maskByte)) === (ord($netBin[$bytes]) & ord($maskByte));
    }
}
