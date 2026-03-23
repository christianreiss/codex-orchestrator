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
use App\Repositories\HostRepository;
use App\Repositories\InsecureAuthRequestRepository;
use App\Repositories\InsecureDomainAllowRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use DateTimeImmutable;

class InsecureHostWindowService
{
    private const MIN_INSECURE_WINDOW_MINUTES = 0;
    private const MAX_INSECURE_WINDOW_MINUTES = 480;
    private const DEFAULT_INSECURE_WINDOW_MINUTES = 10;
    private const MIN_INSECURE_GRACE_MINUTES = 0;
    private const MAX_INSECURE_GRACE_MINUTES = 480;
    private const DEFAULT_INSECURE_GRACE_MINUTES = 60;
    private const DEFAULT_INSECURE_SESSION_MAX_MINUTES = 480;
    private const MAX_INSECURE_SESSION_MAX_MINUTES = 1440;
    private const INSECURE_APPROVAL_DENY_COOLDOWN_SECONDS = 60;
    private const ADMIN_WS_PRESENCE_TTL_SECONDS = 60;
    private const PROVISIONING_WINDOW_MINUTES = 30;

    public function __construct(
        private readonly HostRepository $hosts,
        private readonly ?InsecureAuthRequestRepository $insecureAuthRequests,
        private readonly ?InsecureDomainAllowRepository $insecureDomainAllows,
        private readonly LogRepository $logs,
        private readonly VersionRepository $versions
    ) {
    }

    public function assertInsecureHostWindow(
        array $host,
        int $hostId,
        string $command,
        bool $trackHost,
        ?DateTimeImmutable $sessionStartedAt = null
    ): array {
        $enabledUntilRaw = $host['insecure_enabled_until'] ?? null;
        $graceUntilRaw = $host['insecure_grace_until'] ?? null;

        $enabledUntil = null;
        $graceUntil = null;
        try {
            if (is_string($enabledUntilRaw) && trim($enabledUntilRaw) !== '') {
                $enabledUntil = new DateTimeImmutable($enabledUntilRaw);
            }
        } catch (\Exception) {
            $enabledUntil = null;
        }
        try {
            if (is_string($graceUntilRaw) && trim($graceUntilRaw) !== '') {
                $graceUntil = new DateTimeImmutable($graceUntilRaw);
            }
        } catch (\Exception) {
            $graceUntil = null;
        }

        $now = new DateTimeImmutable('now');
        $enabledActive = $enabledUntil !== null && $enabledUntil >= $now;
        $graceActive = $graceUntil !== null && $graceUntil >= $now;

        if ($enabledActive) {
            if ($trackHost) {
                $windowMinutes = $this->resolveInsecureWindowMinutes($host);
                $newUntil = $now->modify(sprintf('+%d minutes', $windowMinutes));
                $newGrace = $this->computeInsecureGraceUntil($newUntil, $windowMinutes);
                $this->hosts->updateInsecureWindows($hostId, $newUntil->format(DATE_ATOM), $newGrace, null);
                $host['insecure_enabled_until'] = $newUntil->format(DATE_ATOM);
                $host['insecure_grace_until'] = $newGrace;
            }

            return $host;
        }

        if ($command === 'store' && $graceActive) {
            return $host;
        }

        if ($command === 'store' && $this->allowInsecurePostRunStore($sessionStartedAt, $enabledUntil, $now)) {
            $this->logs->log($trackHost ? $hostId : null, 'auth.insecure.post_run_store', [
                'fqdn' => $host['fqdn'] ?? null,
                'session_started_at' => $sessionStartedAt?->format(DATE_ATOM),
                'enabled_until' => $enabledUntilRaw,
            ]);
            return $host;
        }

        $domainAllow = $this->resolveInsecureDomainAllow($host, $now);
        if ($domainAllow !== null && $trackHost) {
            $windowMinutes = $this->resolveInsecureWindowMinutes($host);
            $newUntil = $now->modify(sprintf('+%d minutes', $windowMinutes));
            $newGrace = $this->computeInsecureGraceUntil($newUntil, $windowMinutes);
            $this->hosts->updateInsecureWindows($hostId, $newUntil->format(DATE_ATOM), $newGrace, null);
            $host['insecure_enabled_until'] = $newUntil->format(DATE_ATOM);
            $host['insecure_grace_until'] = $newGrace;

            $domainMinutes = $this->normalizeInsecureWindowMinutes($domainAllow['window_minutes'] ?? null);
            $domainUntil = $now->modify(sprintf('+%d minutes', $domainMinutes));
            $this->insecureDomainAllows?->touchWindow((int) ($domainAllow['id'] ?? 0), $domainUntil->format(DATE_ATOM));

            $this->logs->log($trackHost ? $hostId : null, 'auth.insecure.domain_auto_allow', [
                'command' => $command,
                'fqdn' => $host['fqdn'] ?? null,
                'domain' => $domainAllow['domain'] ?? null,
                'domain_id' => $domainAllow['id'] ?? null,
                'enabled_until' => $newUntil->format(DATE_ATOM),
            ]);

            return $host;
        }

        if ($this->shouldOfferInsecureApproval($hostId)) {
            try {
                $pending = $this->insecureAuthRequests?->findPendingByHost($hostId);
                if ($pending !== null) {
                    throw new HttpException('Insecure host approval pending', 423);
                }

                $latest = $this->insecureAuthRequests?->findLatestByHost($hostId);
                if ($latest !== null && ($latest['status'] ?? '') === 'denied') {
                    $resolvedAt = $latest['resolved_at'] ?? null;
                    if ($this->isRecentResolution($resolvedAt)) {
                        $this->logs->log($trackHost ? $hostId : null, 'auth.insecure.denied', [
                            'command' => $command,
                            'enabled_until' => $enabledUntilRaw,
                            'grace_until' => $graceUntilRaw,
                            'reason' => 'approval_denied',
                        ]);
                        throw new HttpException('Insecure host approval denied', 403);
                    }
                }

                $request = $this->insecureAuthRequests?->create($hostId);
                if ($request !== null) {
                    $this->logs->log($trackHost ? $hostId : null, 'auth.insecure.pending', [
                        'command' => $command,
                        'fqdn' => $host['fqdn'] ?? null,
                        'request_id' => $request['id'] ?? null,
                        'requested_at' => $request['requested_at'] ?? null,
                    ]);
                }

                throw new HttpException('Insecure host approval pending', 423);
            } catch (\Throwable $exception) {
                if ($exception instanceof HttpException) {
                    throw $exception;
                }
                // Fall back to standard denial if approval flow fails.
            }
        }

        $this->logs->log($trackHost ? $hostId : null, 'auth.insecure.denied', [
            'command' => $command,
            'enabled_until' => $enabledUntilRaw,
            'grace_until' => $graceUntilRaw,
        ]);

        throw new HttpException('Insecure host API access disabled', 403, [
            'code' => 'insecure_api_disabled',
            'enabled_until' => $enabledUntilRaw,
            'grace_until' => $graceUntilRaw,
        ]);
    }

    public function enforceInsecureWindow(array $host, string $command = 'mcp'): array
    {
        $hostId = isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : 0;
        $trackHost = $hostId > 0;

        if (isset($host['secure']) && !(bool) (int) $host['secure']) {
            $host = $this->assertInsecureHostWindow($host, $hostId, $command, $trackHost);
        }

        return $host;
    }

    public function resolveInsecureGraceUntil(?string $enabledUntil, ?int $windowMinutes = null): ?string
    {
        if (!is_string($enabledUntil) || trim($enabledUntil) === '') {
            return null;
        }

        try {
            $enabledAt = new DateTimeImmutable($enabledUntil);
        } catch (\Exception) {
            return null;
        }

        return $this->computeInsecureGraceUntil($enabledAt, $windowMinutes);
    }

    public function openInitialInsecureWindow(int $hostId, ?int $windowMinutes = null): void
    {
        $initialWindowMinutes = self::PROVISIONING_WINDOW_MINUTES;
        $storedWindowMinutes = self::DEFAULT_INSECURE_WINDOW_MINUTES;
        if ($windowMinutes !== null) {
            $normalizedWindow = $this->normalizeInsecureWindowMinutes($windowMinutes);
            $initialWindowMinutes = $normalizedWindow;
            $storedWindowMinutes = $normalizedWindow;
        }

        $initialUntil = gmdate(DATE_ATOM, time() + ($initialWindowMinutes * 60));
        $graceUntil = $this->resolveInsecureGraceUntil($initialUntil, $storedWindowMinutes);
        $this->hosts->updateInsecureWindows($hostId, $initialUntil, $graceUntil, $storedWindowMinutes);
        $this->logs->log($hostId, 'auth.insecure.initial_window', [
            'enabled_until' => $initialUntil,
            'window_minutes' => $initialWindowMinutes,
            'stored_window_minutes' => $storedWindowMinutes,
        ]);
    }

    public function pruneExpiredInsecureDomainAllows(): void
    {
        if ($this->insecureDomainAllows === null) {
            return;
        }

        $now = gmdate(DATE_ATOM);
        $this->insecureDomainAllows->revokeExpired($now);
    }

    public function isTimestampActive(mixed $timestamp, DateTimeImmutable $now): bool
    {
        if (!is_string($timestamp) || trim($timestamp) === '') {
            return false;
        }

        try {
            $parsed = new DateTimeImmutable($timestamp);
        } catch (\Exception) {
            return false;
        }

        return $parsed >= $now;
    }

    public function parseSessionStartedAt(mixed $value): ?DateTimeImmutable
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }

        try {
            return new DateTimeImmutable($value);
        } catch (\Exception) {
            return null;
        }
    }

    private function shouldOfferInsecureApproval(int $hostId): bool
    {
        if ($hostId <= 0) {
            return false;
        }

        if ($this->insecureAuthRequests === null) {
            return false;
        }

        if (!$this->versions->getFlag('insecure_approval_enabled', false)) {
            return false;
        }

        return $this->adminWsConnected();
    }

    private function allowInsecurePostRunStore(
        ?DateTimeImmutable $sessionStartedAt,
        ?DateTimeImmutable $enabledUntil,
        DateTimeImmutable $now
    ): bool {
        if ($sessionStartedAt === null || $enabledUntil === null) {
            return false;
        }

        $maxMinutes = $this->resolveInsecureSessionMaxMinutes();
        if ($maxMinutes <= 0) {
            return false;
        }

        $skewSeconds = 300;
        $sessionTs = $sessionStartedAt->getTimestamp();
        $nowTs = $now->getTimestamp();

        if ($sessionTs > ($nowTs + $skewSeconds)) {
            return false;
        }

        if (($nowTs - $sessionTs) > ($maxMinutes * 60)) {
            return false;
        }

        if ($sessionStartedAt > $enabledUntil->modify(sprintf('+%d seconds', $skewSeconds))) {
            return false;
        }

        return true;
    }

    private function resolveInsecureSessionMaxMinutes(): int
    {
        $raw = Config::get('INSECURE_SESSION_MAX_MINUTES', self::DEFAULT_INSECURE_SESSION_MAX_MINUTES);
        if ($raw === null || $raw === '' || !is_numeric($raw)) {
            return self::DEFAULT_INSECURE_SESSION_MAX_MINUTES;
        }

        $value = (int) $raw;
        if ($value < 0) {
            return 0;
        }
        if ($value > self::MAX_INSECURE_SESSION_MAX_MINUTES) {
            return self::MAX_INSECURE_SESSION_MAX_MINUTES;
        }
        return $value;
    }

    private function adminWsConnected(): bool
    {
        $meta = $this->versions->getWithMetadata('admin_ws_connections');
        if ($meta === null) {
            return false;
        }

        $countRaw = $meta['version'] ?? null;
        if (!is_numeric($countRaw)) {
            return false;
        }

        if ((int) $countRaw <= 0) {
            return false;
        }

        $updatedAt = $meta['updated_at'] ?? null;
        if (!is_string($updatedAt) || trim($updatedAt) === '') {
            return false;
        }

        $updatedTs = strtotime($updatedAt);
        if ($updatedTs === false) {
            return false;
        }

        return (time() - $updatedTs) <= self::ADMIN_WS_PRESENCE_TTL_SECONDS;
    }

    private function isRecentResolution(?string $resolvedAt): bool
    {
        if (!is_string($resolvedAt) || trim($resolvedAt) === '') {
            return false;
        }

        $ts = strtotime($resolvedAt);
        if ($ts === false) {
            return false;
        }

        return (time() - $ts) <= self::INSECURE_APPROVAL_DENY_COOLDOWN_SECONDS;
    }

    private function resolveInsecureWindowMinutes(array $host): int
    {
        $raw = $host['insecure_window_minutes'] ?? null;
        if ($raw === null || $raw === '' || !is_numeric($raw)) {
            return self::DEFAULT_INSECURE_WINDOW_MINUTES;
        }

        return $this->normalizeInsecureWindowMinutes((int) $raw);
    }

    private function normalizeInsecureWindowMinutes(?int $minutes): int
    {
        $value = $minutes ?? self::DEFAULT_INSECURE_WINDOW_MINUTES;
        if ($value < self::MIN_INSECURE_WINDOW_MINUTES) {
            return self::MIN_INSECURE_WINDOW_MINUTES;
        }
        if ($value > self::MAX_INSECURE_WINDOW_MINUTES) {
            return self::MAX_INSECURE_WINDOW_MINUTES;
        }
        return $value;
    }

    private function resolveInsecureGraceMinutes(): int
    {
        $raw = Config::get('INSECURE_GRACE_MINUTES', self::DEFAULT_INSECURE_GRACE_MINUTES);
        if ($raw === null || $raw === '' || !is_numeric($raw)) {
            return self::DEFAULT_INSECURE_GRACE_MINUTES;
        }

        return $this->normalizeInsecureGraceMinutes((int) $raw);
    }

    private function normalizeInsecureGraceMinutes(?int $minutes): int
    {
        $value = $minutes ?? self::DEFAULT_INSECURE_GRACE_MINUTES;
        if ($value < self::MIN_INSECURE_GRACE_MINUTES) {
            return self::MIN_INSECURE_GRACE_MINUTES;
        }
        if ($value > self::MAX_INSECURE_GRACE_MINUTES) {
            return self::MAX_INSECURE_GRACE_MINUTES;
        }
        return $value;
    }

    private function computeInsecureGraceUntil(DateTimeImmutable $enabledUntil, ?int $windowMinutes = null): ?string
    {
        if ($windowMinutes !== null && $windowMinutes <= 0) {
            return null;
        }

        $graceMinutes = $this->resolveInsecureGraceMinutes();
        if ($graceMinutes <= 0) {
            return null;
        }

        return $enabledUntil->modify(sprintf('+%d minutes', $graceMinutes))->format(DATE_ATOM);
    }

    private function resolveInsecureDomainAllow(array $host, DateTimeImmutable $now): ?array
    {
        if ($this->insecureDomainAllows === null) {
            return null;
        }

        $fqdnRaw = $host['fqdn'] ?? null;
        if (!is_string($fqdnRaw)) {
            return null;
        }
        $fqdn = strtolower(trim($fqdnRaw));
        if ($fqdn === '') {
            return null;
        }

        $candidates = $this->insecureDomainAllows->listActiveCandidates();
        foreach ($candidates as $candidate) {
            $domainRaw = $candidate['domain'] ?? null;
            if (!is_string($domainRaw)) {
                continue;
            }
            $domain = strtolower(trim($domainRaw));
            if ($domain === '') {
                continue;
            }
            if (!$this->fqdnMatchesDomain($fqdn, $domain)) {
                continue;
            }
            if (!$this->isTimestampActive($candidate['enabled_until'] ?? null, $now)) {
                continue;
            }
            return $candidate;
        }

        return null;
    }

    private function fqdnMatchesDomain(string $fqdn, string $domain): bool
    {
        if ($fqdn === '' || $domain === '') {
            return false;
        }
        $suffix = '.' . $domain;
        $fqdnLength = strlen($fqdn);
        $suffixLength = strlen($suffix);
        if ($fqdnLength <= $suffixLength) {
            return false;
        }

        return substr($fqdn, -$suffixLength) === $suffix;
    }
}
