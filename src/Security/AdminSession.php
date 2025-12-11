<?php

declare(strict_types=1);

namespace App\Security;

/**
 * Session-bound admin passkey state.
 *
 * - Binds to user-agent hash, client IP, and (when present) mTLS fingerprint.
 * - TTL defaults to 30 minutes; cookie is Secure + HttpOnly + SameSite=Strict.
 * - Designed to fall back to an in-memory store for tests.
 */
class AdminSession
{
    private const SESSION_KEY = 'admin_passkey';

    /** @var array<string, mixed>|null */
    private ?array $store;
    private bool $started = false;

    /**
     * @param bool $useNative When true, uses PHP native session storage; otherwise uses the provided $storeRef.
     * @param array<string, mixed>|null $storeRef Reference for test/local storage (ignored when $useNative).
     */
    public function __construct(private readonly bool $useNative = true, ?array &$storeRef = null)
    {
        $this->store = $storeRef;
    }

    public function start(int $cookieTtlSeconds = 1800): void
    {
        if ($this->started) {
            return;
        }

        if ($this->useNative) {
            // Hardened cookie/session defaults.
            $cookieOptions = [
                'lifetime' => $cookieTtlSeconds,
                'path' => '/admin',
                'secure' => true,
                'httponly' => true,
                'samesite' => 'Strict',
            ];
            session_name('admin_passkey');
            session_set_cookie_params($cookieOptions);
            ini_set('session.use_strict_mode', '1');
            ini_set('session.cookie_httponly', '1');
            ini_set('session.cookie_samesite', 'Strict');
            // Do not propagate session IDs via URL.
            ini_set('session.use_only_cookies', '1');
            if (session_status() !== PHP_SESSION_ACTIVE) {
                session_start();
            }
            if (!array_key_exists(self::SESSION_KEY, $_SESSION) || !is_array($_SESSION[self::SESSION_KEY])) {
                $_SESSION[self::SESSION_KEY] = [];
            }
            $this->store = &$_SESSION[self::SESSION_KEY];
        } else {
            if ($this->store === null) {
                $this->store = [];
            }
        }

        $this->started = true;
    }

    public function clear(): void
    {
        if (!$this->started) {
            return;
        }
        if ($this->useNative) {
            if (isset($_SESSION[self::SESSION_KEY])) {
                unset($_SESSION[self::SESSION_KEY]);
            }
        } else {
            $this->store = [];
        }
    }

    public function markAuthenticated(string $userAgent, string $ip, ?string $mtlsFingerprint, int $ttlSeconds): void
    {
        $this->assertStarted();
        $this->store = [
            'ts' => time(),
            'ua' => $this->hashUa($userAgent),
            'ip' => $ip,
            'mtls' => $mtlsFingerprint ?: null,
            'ttl' => $ttlSeconds,
        ];
    }

    public function isValid(string $userAgent, string $ip, ?string $mtlsFingerprint): bool
    {
        $this->assertStarted();
        if (!is_array($this->store) || $this->store === []) {
            return false;
        }

        $ts = $this->store['ts'] ?? 0;
        $ttl = $this->store['ttl'] ?? 0;
        if (!is_int($ts) || !is_int($ttl) || $ts <= 0 || $ttl <= 0) {
            return false;
        }
        if ((time() - $ts) > $ttl) {
            return false;
        }

        $expectedUa = $this->store['ua'] ?? null;
        if (!is_string($expectedUa) || $expectedUa !== $this->hashUa($userAgent)) {
            return false;
        }

        $expectedIp = $this->store['ip'] ?? null;
        if (!is_string($expectedIp) || $expectedIp !== $ip) {
            return false;
        }

        $expectedMtls = $this->store['mtls'] ?? null;
        // Only enforce mTLS fingerprint match if we recorded one (allows passkey-only mode).
        if ($expectedMtls !== null) {
            if (!is_string($mtlsFingerprint) || $mtlsFingerprint !== $expectedMtls) {
                return false;
            }
        }

        return true;
    }

    private function hashUa(string $ua): string
    {
        return hash('sha256', $ua);
    }

    private function assertStarted(): void
    {
        if (!$this->started) {
            throw new \RuntimeException('AdminSession must be started before use.');
        }
    }
}
