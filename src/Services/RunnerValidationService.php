<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Config;
use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Support\Engine;
use App\Support\Timestamp;

class RunnerValidationService
{
    private const RUNNER_PREFLIGHT_INTERVAL_SECONDS = 28800; // 8 hours
    private const RUNNER_FAILURE_BACKOFF_SECONDS = 60;
    private const RUNNER_FAILURE_RETRY_SECONDS = 900; // 15 minutes
    private const RUNNER_BACKGROUND_TIMEOUT_SECONDS = 2.0;
    private const MAX_FUTURE_SKEW_SECONDS = 300;
    private const MIN_LAST_REFRESH_EPOCH = 946684800;

    private int $runnerPreflightIntervalSeconds;

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly AuthPayloadRepository $payloads,
        private readonly HostAuthStateRepository $hostStates,
        private readonly LogRepository $logs,
        private readonly VersionRepository $versions,
        private readonly ?RunnerVerifier $runnerVerifier,
        ?int $runnerPreflightIntervalSeconds = null
    ) {
        $configuredInterval = $runnerPreflightIntervalSeconds ?? (int) Config::get('AUTH_RUNNER_PREFLIGHT_SECONDS', self::RUNNER_PREFLIGHT_INTERVAL_SECONDS);
        $this->runnerPreflightIntervalSeconds = $configuredInterval > 0 ? $configuredInterval : self::RUNNER_PREFLIGHT_INTERVAL_SECONDS;
    }

    /**
     * Periodic preflight invoked on the first API request after the interval (8 hours).
     * Forces a client version refresh and runs the auth runner once with a force flag.
     *
     * @param callable $availableClientVersionRefresher A callable that refreshes client version when called with (true)
     * @param callable $versionSnapshotFn A callable that returns the version snapshot array
     */
    public function runDailyPreflight(?array $hostContext, callable $availableClientVersionRefresher, callable $versionSnapshotFn): void
    {
        $now = time();
        $bootChanged = $this->recordCurrentBootId();
        $lastPreflightRaw = $this->versions->get('daily_preflight') ?? '';
        $lastPreflightTs = $this->parseTimestamp(is_string($lastPreflightRaw) ? $lastPreflightRaw : null);
        $intervalElapsed = $lastPreflightTs === null
            || ($now - $lastPreflightTs) >= $this->runnerPreflightIntervalSeconds
            || $lastPreflightTs > ($now + self::MAX_FUTURE_SKEW_SECONDS);
        $needsVersionRefresh = $bootChanged || $intervalElapsed;

        $didWork = false;
        if ($needsVersionRefresh) {
            $availableClientVersionRefresher(true);
            $didWork = true;
        }

        $shouldRunRunner = false;
        $runnerReason = 'scheduled_preflight';
        if ($bootChanged || $intervalElapsed) {
            $shouldRunRunner = true;
        } elseif ($this->runnerVerifier !== null) {
            [$shouldRun, $recoveryReason] = $this->shouldTriggerRunnerRecovery();
            if ($shouldRun) {
                $shouldRunRunner = true;
                if (is_string($recoveryReason) && $recoveryReason !== '') {
                    $runnerReason = $recoveryReason;
                } else {
                    $runnerReason = 'fail_recovery';
                }
            }
        }

        if ($shouldRunRunner && $this->runnerVerifier !== null) {
            $canonicalPayload = $this->resolveCanonicalPayload();
            if ($canonicalPayload !== null) {
                $runnerHost = $this->resolveRunnerHost($hostContext, $canonicalPayload) ?? [];
                $versions = $versionSnapshotFn();
                [$canonicalPayload] = $this->runnerDailyCheck(
                    $canonicalPayload,
                    $runnerHost,
                    $versions,
                    true,
                    $runnerReason
                );
                $didWork = true;
            }
        }

        if ($didWork) {
            $this->versions->set('daily_preflight', gmdate(DATE_ATOM));
        }
    }

    /**
     * Run the runner against the current canonical auth (daily or manual).
     *
     * @return array{0: ?array, 1: ?string, 2: ?string} Updated canonical payload, digest, last_refresh
     */
    public function runnerDailyCheck(
        ?array $canonicalPayload,
        array $host,
        array $versions,
        bool $forceRun = false,
        string $trigger = 'daily_preflight',
        string $engine = Engine::DEFAULT
    ): array
    {
        if ($canonicalPayload === null || $this->runnerVerifier === null) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        $lastCheck = $this->versions->get('runner_last_check') ?? '';
        $lastFailure = $this->versions->get('runner_last_fail') ?? '';
        $now = time();
        $lastCheckTs = $this->parseTimestamp(is_string($lastCheck) ? $lastCheck : null);
        $runnerFailing = $this->isRunnerFailing();

        if (
            !$forceRun
            && $lastCheckTs !== null
            && ($now - $lastCheckTs) < $this->runnerPreflightIntervalSeconds
        ) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        if (
            !$forceRun
            && $runnerFailing
            && $lastFailure !== ''
            && ($lastFailureTs = strtotime($lastFailure)) !== false
            && ($now - $lastFailureTs) < self::RUNNER_FAILURE_BACKOFF_SECONDS
        ) {
            return [$canonicalPayload, $canonicalPayload['sha256'] ?? null, $canonicalPayload['last_refresh'] ?? null];
        }

        [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh] = $this->runRunnerValidationAttempt(
            $canonicalPayload,
            $host,
            $versions,
            $trigger,
            $engine
        );

        return [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh];
    }

    /**
     * Run the runner once and apply any returned auth updates.
     *
     * @return array{0: ?array, 1: ?string, 2: ?string, 3: ?array|null}
     */
    public function runRunnerValidationAttempt(
        array $canonicalPayload,
        array $host,
        array $versions,
        string $trigger,
        string $engine = Engine::DEFAULT
    ): array
    {
        $validatedCanonical = $this->validateCanonicalPayload($canonicalPayload);
        if ($validatedCanonical === null) {
            return [null, null, null, null];
        }

        $canonicalAuth = $validatedCanonical['auth'];
        $currentDigest = $validatedCanonical['digest'];
        $currentLastRefresh = $validatedCanonical['last_refresh'];

        $hostId = (int) ($host['id'] ?? 0);
        $trackHost = $hostId > 0;
        $logHostId = $trackHost ? $hostId : null;
        $runnerReachable = false;
        $validation = null;
        try {
            $validation = $this->runnerVerifier->verify(
                $canonicalAuth,
                null,
                $this->runnerTimeoutForTrigger($trigger),
                $host
            );
            $runnerReachable = (bool) ($validation['reachable'] ?? false);
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
                $runnerAuth = $this->ensureAuthsFallback($runnerAuth, $engine);
                $runnerEntries = $this->normalizeAuthEntries($runnerAuth, $engine);
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
                    $payloadRow = $this->payloads->create(
                        (string) $runnerLastRefresh,
                        $runnerDigest,
                        $trackHost ? $hostId : null,
                        $runnerEntries,
                        $runnerEncoded,
                        $engine
                    );
                    $this->versions->set($this->canonicalPayloadVersionKey($engine), (string) $payloadRow['id']);
                    $canonicalPayload = $payloadRow;

                    if ($trackHost) {
                        $this->hostStates->upsert($hostId, (int) $payloadRow['id'], $runnerDigest, $engine);
                        $this->hosts->updateSyncStateForEngine($hostId, (string) $runnerLastRefresh, $runnerDigest, $engine);
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
            $this->recordRunnerOutcome($validation ?? ['status' => 'fail'], $runnerReachable, $trigger, $engine);
        }

        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;
        return [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh, $validation];
    }

    /**
     * Promote or reject a pending auth_payloads row by running the runner against it.
     *
     * @return array{state: string, reason: ?string, payload_id: int, canonical_moved: bool, canonical_payload_id: ?int}
     */
    public function verifyPendingPayload(array $pendingPayload, string $engine = Engine::DEFAULT): array
    {
        $engine = Engine::validate($engine);
        $payloadId = isset($pendingPayload['id']) ? (int) $pendingPayload['id'] : 0;
        if ($payloadId <= 0) {
            return [
                'state' => 'skipped',
                'reason' => 'missing_payload_id',
                'payload_id' => 0,
                'canonical_moved' => false,
                'canonical_payload_id' => null,
            ];
        }

        if ($this->runnerVerifier === null) {
            return [
                'state' => 'skipped',
                'reason' => 'runner_not_configured',
                'payload_id' => $payloadId,
                'canonical_moved' => false,
                'canonical_payload_id' => null,
            ];
        }

        $validated = $this->validateCanonicalPayload($pendingPayload);
        if ($validated === null) {
            $this->payloads->markRejected($payloadId, 'canonical_invalid');
            return [
                'state' => 'rejected',
                'reason' => 'canonical_invalid',
                'payload_id' => $payloadId,
                'canonical_moved' => false,
                'canonical_payload_id' => null,
            ];
        }

        $canonicalAuth = $validated['auth'];
        $host = $this->resolveRunnerHost(null, $pendingPayload) ?? [];
        $hostId = (int) ($host['id'] ?? 0);
        $logHostId = $hostId > 0 ? $hostId : null;
        $trackHost = $hostId > 0;
        $runnerReachable = false;
        $validation = null;

        try {
            $validation = $this->runnerVerifier->verify(
                $canonicalAuth,
                null,
                $this->runnerTimeoutForTrigger('preflight_cron'),
                $host
            );
            $runnerReachable = (bool) ($validation['reachable'] ?? false);
            $this->logs->log($logHostId, 'auth.validate', [
                'status' => $validation['status'] ?? null,
                'reason' => $validation['reason'] ?? null,
                'latency_ms' => $validation['latency_ms'] ?? null,
                'trigger' => 'preflight_cron',
                'payload_id' => $payloadId,
            ]);
        } catch (\Throwable $exception) {
            $this->logs->log($logHostId, 'auth.validate', [
                'status' => 'fail',
                'reason' => $exception->getMessage(),
                'trigger' => 'preflight_cron',
                'payload_id' => $payloadId,
            ]);
            $this->recordRunnerOutcome(['status' => 'fail'], false, 'preflight_cron', $engine);

            return [
                'state' => 'skipped',
                'reason' => 'runner_exception: ' . $exception->getMessage(),
                'payload_id' => $payloadId,
                'canonical_moved' => false,
                'canonical_payload_id' => null,
            ];
        } finally {
            if ($validation !== null) {
                $this->recordRunnerOutcome($validation, $runnerReachable, 'preflight_cron', $engine);
            }
        }

        if (!$runnerReachable) {
            return [
                'state' => 'skipped',
                'reason' => 'runner_unreachable',
                'payload_id' => $payloadId,
                'canonical_moved' => false,
                'canonical_payload_id' => null,
            ];
        }

        $runnerStatus = strtolower((string) ($validation['status'] ?? 'fail'));
        if ($runnerStatus !== 'ok') {
            $reason = isset($validation['reason']) && is_string($validation['reason']) ? $validation['reason'] : 'runner_rejected';
            $this->payloads->markRejected($payloadId, $reason);
            $this->logs->log($logHostId, 'auth.runner_store', [
                'status' => 'rejected',
                'trigger' => 'preflight_cron',
                'reason' => $reason,
                'payload_id' => $payloadId,
            ]);

            return [
                'state' => 'rejected',
                'reason' => $reason,
                'payload_id' => $payloadId,
                'canonical_moved' => false,
                'canonical_payload_id' => null,
            ];
        }

        $promotedPayloadId = $payloadId;
        $canonicalPayload = $pendingPayload;
        $currentDigest = $validated['digest'];
        $currentLastRefresh = $validated['last_refresh'];

        if (isset($validation['updated_auth']) && is_array($validation['updated_auth'])) {
            try {
                $runnerAuth = $validation['updated_auth'];
                $runnerLastRefresh = $runnerAuth['last_refresh'] ?? null;
                $this->assertReasonableLastRefresh((string) $runnerLastRefresh, 'auth.last_refresh');
                $runnerAuth = $this->ensureAuthsFallback($runnerAuth, $engine);
                $runnerEntries = $this->normalizeAuthEntries($runnerAuth, $engine);
                $runnerCanonical = $this->canonicalizeAuthPayload($runnerAuth, $runnerEntries, (string) $runnerLastRefresh);
                $runnerEncoded = json_encode($runnerCanonical, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
                if ($runnerEncoded === false) {
                    throw new ValidationException(['auth' => ['Unable to encode runner auth payload']]);
                }
                $runnerDigest = $this->calculateDigest($runnerEncoded);

                $comparison = Timestamp::compare((string) $runnerLastRefresh, $currentLastRefresh);
                if ($comparison === 1 || ($comparison === 0 && $runnerDigest !== $currentDigest)) {
                    $sourceHostForPayload = $trackHost
                        ? $hostId
                        : (isset($pendingPayload['source_host_id']) && is_numeric($pendingPayload['source_host_id'])
                            ? (int) $pendingPayload['source_host_id']
                            : null);
                    if ($sourceHostForPayload === 0) {
                        $sourceHostForPayload = null;
                    }
                    $payloadRow = $this->payloads->create(
                        (string) $runnerLastRefresh,
                        $runnerDigest,
                        $sourceHostForPayload,
                        $runnerEntries,
                        $runnerEncoded,
                        $engine,
                        \App\Repositories\AuthPayloadRepository::STATE_VERIFIED
                    );
                    $promotedPayloadId = (int) $payloadRow['id'];
                    $canonicalPayload = $payloadRow;
                    $currentDigest = $runnerDigest;
                    $currentLastRefresh = (string) $runnerLastRefresh;
                    $this->logs->log($logHostId, 'auth.runner_store', [
                        'status' => 'applied',
                        'trigger' => 'preflight_cron',
                        'incoming_last_refresh' => $runnerLastRefresh,
                        'incoming_digest' => $runnerDigest,
                        'source_payload_id' => $payloadId,
                    ]);
                    // Mark the pending one as verified too (the runner confirmed it was a valid input).
                    $this->payloads->markVerified($payloadId, 'runner_applied_update');
                } else {
                    $this->payloads->markVerified($payloadId, 'runner_ok');
                }
            } catch (\Throwable $exception) {
                $this->payloads->markVerified($payloadId, 'runner_ok');
                $this->logs->log($logHostId, 'auth.runner_store', [
                    'status' => 'updated_auth_failed',
                    'trigger' => 'preflight_cron',
                    'reason' => $exception->getMessage(),
                    'payload_id' => $payloadId,
                ]);
            }
        } else {
            $this->payloads->markVerified($payloadId, 'runner_ok');
        }

        $this->versions->set($this->canonicalPayloadVersionKey($engine), (string) $promotedPayloadId);

        if ($trackHost) {
            $this->hostStates->upsert($hostId, $promotedPayloadId, (string) $currentDigest, $engine);
            $this->hosts->updateSyncStateForEngine($hostId, $currentLastRefresh, (string) $currentDigest, $engine);
        }

        return [
            'state' => 'verified',
            'reason' => null,
            'payload_id' => $payloadId,
            'canonical_moved' => true,
            'canonical_payload_id' => $promotedPayloadId,
        ];
    }

    /**
     * When the runner is failing, decide if we should block the request to re-validate auth.
     *
     * @return array{0: ?array, 1: ?array, 2: ?string, 3: ?string}
     */
    public function enforceRunnerValidationOnFailure(
        ?array $canonicalPayload,
        ?array $canonicalAuthArray,
        array $host,
        array $versions,
        string $engine = Engine::DEFAULT
    ): array
    {
        $canonicalDigest = $canonicalPayload['sha256'] ?? null;
        $canonicalLastRefresh = $canonicalPayload['last_refresh'] ?? null;

        [$shouldRun, $recoveryReason] = $this->shouldTriggerRunnerRecovery();
        if (!$shouldRun || $canonicalPayload === null || $canonicalAuthArray === null) {
            return [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh];
        }

        $runnerHost = $this->resolveRunnerHost($host, $canonicalPayload) ?? [];

        [$canonicalPayload, $canonicalDigest, $canonicalLastRefresh, $validation] = $this->runRunnerValidationAttempt(
            $canonicalPayload,
            $runnerHost,
            $versions,
            'fail_recovery',
            $engine
        );

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

        $runnerStatus = strtolower((string) ($validation['status'] ?? 'fail'));
        if ($runnerStatus !== 'ok') {
            $hostIdForLog = isset($runnerHost['id']) && is_numeric($runnerHost['id']) ? (int) $runnerHost['id'] : null;
            try {
                $this->logs->log(
                    $hostIdForLog,
                    'auth.runner_store',
                    [
                        'status' => 'fail',
                        'trigger' => 'fail_recovery',
                        'recovery_reason' => $recoveryReason,
                        'reason' => $validation['reason'] ?? null,
                    ]
                );
            } catch (\Throwable) {
            }
            return [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh];
        }

        return [$canonicalPayload, $canonicalAuthArray, $canonicalDigest, $canonicalLastRefresh];
    }

    public function recordRunnerOutcome(array $validation, bool $reachable, string $trigger, string $engine = Engine::DEFAULT): void
    {
        $engine = Engine::validate($engine);
        $status = strtolower((string) ($validation['status'] ?? 'fail'));
        $nowIso = gmdate(DATE_ATOM);
        $stateKey = $this->runnerStateKey($engine);
        $lastOkKey = $this->runnerLastOkKey($engine);
        $lastFailKey = $this->runnerLastFailKey($engine);
        $lastCheckKey = $this->runnerLastCheckKey($engine);

        if ($status === 'ok') {
            $this->versions->set($stateKey, 'ok');
            $this->versions->set($lastOkKey, $nowIso);
        } else {
            $this->versions->set($stateKey, 'fail');
            $this->versions->set($lastFailKey, $nowIso);
        }

        $this->versions->set($lastCheckKey, $nowIso);
    }

    public function triggerRunnerRefresh(callable $versionSnapshotFn): array
    {
        if ($this->runnerVerifier === null) {
            throw new HttpException('Runner not configured', 503);
        }

        $canonicalPayload = $this->resolveCanonicalPayload();
        if ($canonicalPayload === null) {
            throw new HttpException('No canonical auth payload available', 404);
        }

        $host = $this->resolveRunnerHost(null, $canonicalPayload) ?? [];

        $versions = $versionSnapshotFn();
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
            'engine' => Engine::CODEX,
            'applied' => $applied,
            'canonical_digest' => $newDigest,
            'canonical_last_refresh' => $newLastRefresh,
            'runner_last_check' => $this->versions->get('runner_last_check'),
            'runner_last_fail' => $this->versions->get('runner_last_fail'),
            'runner_last_ok' => $this->versions->get('runner_last_ok'),
            'runner_state' => $this->versions->get('runner_state'),
            'runner_boot_id' => $this->versions->get('runner_boot_id'),
        ];
    }

    /**
     * Trigger a manual Claude runner verification.
     *
     * Unlike triggerRunnerRefresh, this does NOT use the Codex canonical-digest
     * ladder. It calls RunnerVerifier::verifyClaude directly against the most
     * recent Anthropic canonical payload stored in auth_payloads (engine=claude).
     *
     * @return array<string, mixed>
     */
    public function triggerRunnerRefreshClaude(callable $versionSnapshotFn): array
    {
        if ($this->runnerVerifier === null) {
            throw new HttpException('Runner not configured', 503);
        }

        $engine = Engine::CLAUDE;
        $canonicalPayload = $this->resolveCanonicalPayload($engine);
        if ($canonicalPayload === null) {
            throw new HttpException('No Claude canonical auth payload available', 404);
        }

        $validated = $this->validateCanonicalPayload($canonicalPayload);
        if ($validated === null) {
            throw new HttpException('Claude canonical auth payload invalid', 409);
        }

        $validation = null;
        $reachable = false;
        $host = $this->resolveRunnerHost(null, $canonicalPayload) ?? [];
        $hostIdForLog = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;
        $authArray = is_array($validated['auth'] ?? null) ? $validated['auth'] : [];

        try {
            $validation = $this->runnerVerifier->verifyClaude($authArray);
            $reachable = (bool) ($validation['reachable'] ?? false);
            $this->logs->log($hostIdForLog, 'auth.validate_claude', [
                'status' => $validation['status'] ?? null,
                'reason' => $validation['reason'] ?? null,
                'latency_ms' => $validation['latency_ms'] ?? null,
                'trigger' => 'manual',
            ]);
        } catch (\Throwable $exception) {
            $this->logs->log($hostIdForLog, 'auth.validate_claude', [
                'status' => 'fail',
                'reason' => $exception->getMessage(),
                'trigger' => 'manual',
            ]);
        } finally {
            $this->recordRunnerOutcome(is_array($validation) ? $validation : ['status' => 'fail'], $reachable, 'manual', $engine);
        }

        $validationArr = is_array($validation) ? $validation : [];
        return [
            'engine' => $engine,
            'applied' => false,
            'status' => $validationArr['status'] ?? 'fail',
            'reason' => $validationArr['reason'] ?? null,
            'latency_ms' => $validationArr['latency_ms'] ?? null,
            'claude_version' => $validationArr['claude_version'] ?? null,
            'canonical_digest' => $validated['digest'] ?? null,
            'canonical_last_refresh' => $validated['last_refresh'] ?? null,
            'runner_last_check' => $this->versions->get($this->runnerLastCheckKey($engine)),
            'runner_last_fail' => $this->versions->get($this->runnerLastFailKey($engine)),
            'runner_last_ok' => $this->versions->get($this->runnerLastOkKey($engine)),
            'runner_state' => $this->versions->get($this->runnerStateKey($engine)),
            'runner_boot_id' => $this->versions->get('runner_boot_id'),
        ];
    }

    private function runnerStateKey(string $engine): string
    {
        return $engine === Engine::CLAUDE ? 'runner_state_claude' : 'runner_state';
    }

    private function runnerLastCheckKey(string $engine): string
    {
        return $engine === Engine::CLAUDE ? 'runner_last_check_claude' : 'runner_last_check';
    }

    private function runnerLastOkKey(string $engine): string
    {
        return $engine === Engine::CLAUDE ? 'runner_last_ok_claude' : 'runner_last_ok';
    }

    private function runnerLastFailKey(string $engine): string
    {
        return $engine === Engine::CLAUDE ? 'runner_last_fail_claude' : 'runner_last_fail';
    }

    public function isRunnerFailing(): bool
    {
        return strtolower((string) ($this->versions->get('runner_state') ?? '')) === 'fail';
    }

    /**
     * @return array{0: bool, 1: ?string} [shouldRun, reason]
     */
    public function shouldTriggerRunnerRecovery(): array
    {
        $bootChanged = $this->recordCurrentBootId();

        $state = strtolower((string) ($this->versions->get('runner_state') ?? ''));
        if ($state !== 'fail') {
            return [false, null];
        }

        $now = time();
        $lastFailTs = $this->parseTimestamp($this->versions->get('runner_last_fail'));
        $fifteenMinutesElapsed = $lastFailTs === null || ($now - $lastFailTs) >= self::RUNNER_FAILURE_RETRY_SECONDS;

        if ($bootChanged) {
            return [true, 'boot'];
        }
        if (!$fifteenMinutesElapsed) {
            return [false, null];
        }

        return [true, 'fail_backoff'];
    }

    private function runnerTimeoutForTrigger(string $trigger): ?float
    {
        return in_array($trigger, ['scheduled_preflight', 'daily_preflight', 'fail_recovery', 'fail_backoff', 'boot', 'preflight_cron'], true)
            ? self::RUNNER_BACKGROUND_TIMEOUT_SECONDS
            : null;
    }

    public function recordCurrentBootId(): bool
    {
        $currentBootId = $this->currentBootId();
        if ($currentBootId === null || $currentBootId === '') {
            return false;
        }

        $stored = $this->versions->get('runner_boot_id');
        if ($stored === $currentBootId) {
            return false;
        }

        $this->versions->set('runner_boot_id', $currentBootId);
        return true;
    }

    public function resolveCanonicalPayload(string $engine = Engine::DEFAULT): ?array
    {
        $engine = Engine::validate($engine);

        $verified = $this->payloads->latestVerified($engine);
        if ($verified !== null) {
            return $verified;
        }

        $id = $this->versions->get($this->canonicalPayloadVersionKey($engine));
        if ($id !== null && ctype_digit((string) $id)) {
            $payload = $this->payloads->findByIdWithEntries((int) $id, $engine);
            if ($payload) {
                return $payload;
            }
        }

        return $this->payloads->latest($engine);
    }

    public function resolveRunnerHost(?array $hostContext = null, ?array $canonicalPayload = null): ?array
    {
        if ($hostContext !== null && isset($hostContext['id'])) {
            return $hostContext;
        }

        $sourceHostId = isset($canonicalPayload['source_host_id']) ? (int) $canonicalPayload['source_host_id'] : null;
        if ($sourceHostId !== null && $sourceHostId > 0) {
            $sourceHost = $this->hosts->findById($sourceHostId);
            if ($sourceHost !== null) {
                return $sourceHost;
            }
        }

        $hosts = $this->hosts->all();

        return $hosts[0] ?? null;
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
            $payloadEngine = isset($payload['engine']) && is_string($payload['engine']) && Engine::isValid($payload['engine'])
                ? $payload['engine']
                : Engine::DEFAULT;
            $this->normalizeAuthEntries($auth, $payloadEngine);

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

    public function canonicalAuthFromPayload(array $payload): array
    {
        if (isset($payload['body']) && is_string($payload['body']) && $payload['body'] !== '') {
            $decoded = json_decode($payload['body'], true);
            if (is_array($decoded)) {
                return $decoded;
            }
        }

        return $this->buildAuthArrayFromPayload($payload);
    }

    public function canonicalAuthSnapshot(): ?array
    {
        $payload = $this->resolveCanonicalPayload();
        if ($payload === null) {
            return null;
        }

        $validated = $this->validateCanonicalPayload($payload);

        return $validated['auth'] ?? null;
    }

    public function hasCanonicalAuth(): bool
    {
        return $this->resolveCanonicalPayload() !== null;
    }

    private function canonicalPayloadVersionKey(string $engine): string
    {
        $engine = Engine::validate($engine);
        return $engine === Engine::CLAUDE ? 'canonical_payload_id_claude' : 'canonical_payload_id';
    }

    public function calculateDigest(?string $authJson): ?string
    {
        if ($authJson === null || $authJson === '') {
            return null;
        }

        return hash('sha256', $authJson);
    }

    // --- Auth payload helpers used during runner validation ---

    public function ensureAuthsFallback(array $authPayload, string $engine = Engine::DEFAULT): array
    {
        $engine = Engine::validate($engine);
        $hasAuths = isset($authPayload['auths']) && is_array($authPayload['auths']) && count($authPayload['auths']) > 0;
        if ($hasAuths) {
            return $authPayload;
        }

        $tokenCandidates = [];
        if ($engine === Engine::CLAUDE) {
            $tokenCandidates[] = $authPayload['api_key'] ?? null;
            $tokenCandidates[] = $authPayload['anthropic_api_key'] ?? null;
            $tokenCandidates[] = $authPayload['ANTHROPIC_API_KEY'] ?? null;
        } else {
            if (isset($authPayload['tokens']) && is_array($authPayload['tokens'])) {
                $tokenCandidates[] = $authPayload['tokens']['access_token'] ?? null;
            }
            if (isset($authPayload['OPENAI_API_KEY'])) {
                $tokenCandidates[] = $authPayload['OPENAI_API_KEY'];
            }
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
            ($engine === Engine::CLAUDE ? 'api.anthropic.com' : 'api.openai.com') => [
                'token' => $chosen,
                'token_type' => 'bearer',
            ],
        ];

        return $authPayload;
    }

    public function normalizeAuthEntries(array $authPayload, string $engine = Engine::DEFAULT): array
    {
        $engine = Engine::validate($engine);
        if (!isset($authPayload['auths']) || !is_array($authPayload['auths']) || count($authPayload['auths']) === 0) {
            $fallbackToken = null;
            if ($engine === Engine::CLAUDE) {
                foreach ([
                    $authPayload['api_key'] ?? null,
                    $authPayload['anthropic_api_key'] ?? null,
                    $authPayload['ANTHROPIC_API_KEY'] ?? null,
                ] as $candidate) {
                    if (is_string($candidate) && trim($candidate) !== '') {
                        $fallbackToken = trim($candidate);
                        break;
                    }
                }
            } else {
                if (isset($authPayload['tokens']['access_token']) && is_string($authPayload['tokens']['access_token'])) {
                    $fallbackToken = trim($authPayload['tokens']['access_token']);
                } elseif (isset($authPayload['OPENAI_API_KEY']) && is_string($authPayload['OPENAI_API_KEY'])) {
                    $fallbackToken = trim($authPayload['OPENAI_API_KEY']);
                }
            }

            if ($fallbackToken !== null && $fallbackToken !== '') {
                $authPayload['auths'] = [
                    ($engine === Engine::CLAUDE ? 'api.anthropic.com' : 'api.openai.com') => [
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

    public function canonicalizeAuthPayload(array $incomingAuth, array $entries, string $incomingLastRefresh): array
    {
        $normalized = $incomingAuth;
        $normalized['last_refresh'] = $incomingLastRefresh;
        $normalized['auths'] = $this->buildAuthArrayFromEntries($incomingLastRefresh, $entries)['auths'];

        return $normalized;
    }

    public function buildAuthArrayFromEntries(string $lastRefresh, array $entries): array
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

    public function assertReasonableLastRefresh(string $value, string $field): void
    {
        try {
            $dt = new \DateTimeImmutable($value);
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

    private function currentBootId(): ?string
    {
        $bootIdPath = '/proc/sys/kernel/random/boot_id';
        $base = null;
        if (is_readable($bootIdPath)) {
            $value = trim((string) file_get_contents($bootIdPath));
            if ($value !== '') {
                $base = $value;
            }
        }

        $procStart = @filemtime('/proc/1');
        if ($base !== null && $procStart !== false) {
            return $base . '|p1-' . $procStart;
        }

        if ($base !== null) {
            return $base;
        }

        if ($procStart !== false) {
            return 'proc1-' . $procStart;
        }

        $hostname = php_uname('n');
        return $hostname !== '' ? 'host-' . $hostname : null;
    }

    public function parseTimestamp(?string $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }

        $parsed = strtotime($value);
        return $parsed === false ? null : $parsed;
    }
}
