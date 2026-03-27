<?php

declare(strict_types=1);

namespace App\Services;

use App\Exceptions\HttpException;
use App\Repositories\CliAuthRequestRepository;
use App\Repositories\LogRepository;
use App\Security\RateLimiter;
class CliAuthService
{
    private const TTL_SECONDS = 600;
    private const MAX_PENDING_PER_IP = 10;
    private const POLL_INTERVAL = 5;

    private const ALPHA_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    private const DIGIT_CHARS = '23456789';

    public function __construct(
        private readonly CliAuthRequestRepository $repository,
        private readonly AuthService $authService,
        private readonly LogRepository $logs,
        private readonly RateLimiter $rateLimiter
    ) {
    }

    public function startRequest(string $fqdn, bool $secure, ?string $ip, ?string $userAgent): array
    {
        $fqdn = trim($fqdn);
        if ($fqdn === '') {
            throw new HttpException('fqdn is required', 422);
        }

        if ($ip !== null && $ip !== '') {
            $rateResult = $this->rateLimiter->hit($ip, 'cli_auth_start', self::MAX_PENDING_PER_IP, 3600);
            if (!$rateResult['allowed']) {
                throw new HttpException('Too many login requests. Try again later.', 429);
            }
        }

        $this->repository->deleteExpired(gmdate(DATE_ATOM));

        $requestId = bin2hex(random_bytes(32));
        $userCode = $this->generateUserCode();
        $expiresAt = gmdate(DATE_ATOM, time() + self::TTL_SECONDS);

        $row = $this->repository->create($requestId, $userCode, $fqdn, $secure, $expiresAt, $ip, $userAgent);

        $this->logs->log(null, 'cli_auth.start', [
            'fqdn' => $fqdn,
            'ip' => $ip,
            'user_code' => $userCode,
        ]);

        return [
            'request_id' => $requestId,
            'user_code' => $userCode,
            'expires_in' => self::TTL_SECONDS,
            'poll_interval' => self::POLL_INTERVAL,
        ];
    }

    public function pollRequest(string $requestId): array
    {
        $row = $this->repository->findByRequestId($requestId);
        if (!$row) {
            return ['status' => 'not_found'];
        }

        $expiresTs = strtotime($row['expires_at'] ?? '');
        if ($expiresTs !== false && $expiresTs <= time()) {
            return ['status' => 'expired'];
        }

        $status = $row['status'] ?? 'pending';

        if ($status === 'pending') {
            return ['status' => 'pending'];
        }

        if ($status === 'denied') {
            return ['status' => 'denied'];
        }

        if ($status === 'approved') {
            if ($row['consumed_at'] !== null) {
                return ['status' => 'consumed'];
            }

            $this->repository->markConsumed((int) $row['id']);

            $apiKey = $row['api_key_plain'] ?? null;
            $fqdn = $row['fqdn'] ?? '';
            $secure = (bool) (int) ($row['secure'] ?? 1);

            return [
                'status' => 'approved',
                'api_key' => $apiKey,
                'fqdn' => $fqdn,
                'secure' => $secure,
            ];
        }

        return ['status' => $status];
    }

    public function lookupRequest(string $userCode): ?array
    {
        $userCode = strtoupper(trim($userCode));
        $row = $this->repository->findByUserCode($userCode);
        if (!$row) {
            return null;
        }

        $expiresTs = strtotime($row['expires_at'] ?? '');
        if ($expiresTs !== false && $expiresTs <= time()) {
            return null;
        }

        return [
            'id' => (int) $row['id'],
            'fqdn' => $row['fqdn'] ?? '',
            'secure' => (bool) (int) ($row['secure'] ?? 1),
            'ip' => $row['ip'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'expires_at' => $row['expires_at'] ?? null,
        ];
    }

    public function approveRequest(string $userCode, array $adminUser): array
    {
        $userCode = strtoupper(trim($userCode));
        $row = $this->repository->findByUserCode($userCode);
        if (!$row) {
            throw new HttpException('Login request not found or expired', 404);
        }

        $expiresTs = strtotime($row['expires_at'] ?? '');
        if ($expiresTs !== false && $expiresTs <= time()) {
            throw new HttpException('Login request has expired', 410);
        }

        $fqdn = $row['fqdn'] ?? '';
        $secure = (bool) (int) ($row['secure'] ?? 1);
        $userId = (int) ($adminUser['id'] ?? 0);

        $hostPayload = $this->authService->register($fqdn, $secure);
        $apiKey = $hostPayload['api_key'] ?? ($hostPayload['api_key_plain'] ?? '');
        $hostId = (int) ($hostPayload['id'] ?? 0);

        $this->repository->approve((int) $row['id'], $userId, $hostId, $apiKey);

        $this->logs->log($hostId, 'cli_auth.approve', [
            'fqdn' => $fqdn,
            'approved_by' => $adminUser['username'] ?? 'unknown',
        ]);

        return [
            'fqdn' => $fqdn,
            'host_id' => $hostId,
        ];
    }

    public function denyRequest(string $userCode): void
    {
        $userCode = strtoupper(trim($userCode));
        $row = $this->repository->findByUserCode($userCode);
        if (!$row) {
            throw new HttpException('Login request not found or expired', 404);
        }

        $this->repository->deny((int) $row['id']);

        $this->logs->log(null, 'cli_auth.deny', [
            'fqdn' => $row['fqdn'] ?? '',
        ]);
    }

    private function generateUserCode(): string
    {
        $alpha = '';
        for ($i = 0; $i < 4; $i++) {
            $alpha .= self::ALPHA_CHARS[random_int(0, strlen(self::ALPHA_CHARS) - 1)];
        }

        $digits = '';
        for ($i = 0; $i < 4; $i++) {
            $digits .= self::DIGIT_CHARS[random_int(0, strlen(self::DIGIT_CHARS) - 1)];
        }

        return $alpha . '-' . $digits;
    }
}
