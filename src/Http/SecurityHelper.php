<?php

namespace App\Http;

use App\Config;
use App\Security\RateLimiter;

final class SecurityHelper
{
    public static function enforceGlobalRateLimit(?RateLimiter $rateLimiter, ?string $clientIp, string $method, string $path): void
    {
        if ($rateLimiter === null || $clientIp === null || $clientIp === '') {
            return;
        }

        if (str_starts_with($path, '/admin')) {
            return;
        }

        $limit = (int) Config::get('RATE_LIMIT_GLOBAL_PER_MINUTE', 120);
        $windowSeconds = (int) Config::get('RATE_LIMIT_GLOBAL_WINDOW', 60);
        if ($limit <= 0 || $windowSeconds <= 0) {
            return;
        }

        $result = $rateLimiter->hit($clientIp, 'global', $limit, $windowSeconds);
        if ($result['allowed']) {
            return;
        }

        Response::json([
            'status' => 'error',
            'message' => 'Rate limit exceeded',
            'data' => [
                'bucket' => 'global',
                'reset_at' => $result['reset_at'],
                'limit' => $result['limit'],
            ],
        ], 429);
    }

    public static function resolveMtls(): array
    {
        $required = self::isMtlsRequired();
        $fingerprintRaw = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? ($_SERVER['HTTP_X_MTLS_PRESENT'] ?? '');
        $fingerprint = is_string($fingerprintRaw) ? preg_replace('/[^A-Fa-f0-9]/', '', $fingerprintRaw) : '';
        $present = is_string($fingerprint) && strlen($fingerprint) >= 64 && preg_match('/^[A-Fa-f0-9]+$/', $fingerprint) === 1;

        $meta = [
            'required' => $required,
            'present' => $present,
            'enforced' => $required && $present,
        ];

        if ($present) {
            $meta['fingerprint'] = $fingerprint;
            $meta['subject'] = $_SERVER['HTTP_X_MTLS_SUBJECT'] ?? null;
            $meta['issuer'] = $_SERVER['HTTP_X_MTLS_ISSUER'] ?? null;
        }

        return $meta;
    }

    public static function isMtlsRequired(): bool
    {
        $mode = AdminSessionHelper::adminAccessMode();
        return $mode === 'mtls';
    }

    public static function isMtlsSatisfied(): bool
    {
        $fp = $_SERVER['HTTP_X_MTLS_FINGERPRINT'] ?? ($_SERVER['HTTP_X_MTLS_PRESENT'] ?? '');
        return is_string($fp) && preg_match('/^[A-Fa-f0-9]{64}$/', $fp) === 1;
    }

    public static function isHttpsRequest(): bool
    {
        return RequestHelper::resolveRequestScheme() === 'https';
    }
}
