<?php

namespace App\Http;

use App\Config;

final class InstallerHelper
{
    public static function resolveInstallerBaseUrl(?array $tokenRow = null): string
    {
        $baseUrl = '';
        if ($tokenRow && isset($tokenRow['base_url']) && is_string($tokenRow['base_url'])) {
            $baseUrl = trim((string) $tokenRow['base_url']);
        }

        if ($baseUrl === '') {
            $baseUrl = RequestHelper::resolveBaseUrl();
        }

        if ($baseUrl === '' || $baseUrl === 'http://' || $baseUrl === 'https://') {
            $fallbackBase = Config::get('PUBLIC_BASE_URL', '');
            if (is_string($fallbackBase) && trim($fallbackBase) !== '') {
                $baseUrl = trim($fallbackBase);
            }
        }

        return RequestHelper::normalizeBaseUrlCandidate($baseUrl);
    }

    public static function resolveSeedBaseUrl(?array $tokenRow = null): string
    {
        $baseUrl = '';
        if ($tokenRow && isset($tokenRow['base_url']) && is_string($tokenRow['base_url'])) {
            $baseUrl = trim((string) $tokenRow['base_url']);
        }

        if ($baseUrl === '') {
            $baseUrl = RequestHelper::resolveBaseUrl();
        }

        if ($baseUrl === '' || $baseUrl === 'http://' || $baseUrl === 'https://') {
            $fallbackBase = Config::get('PUBLIC_BASE_URL', '');
            if (is_string($fallbackBase) && trim($fallbackBase) !== '') {
                $baseUrl = trim($fallbackBase);
            }
        }

        return RequestHelper::normalizeBaseUrlCandidate($baseUrl);
    }

    public static function installerCommand(string $baseUrl, string $token): string
    {
        $base = rtrim($baseUrl, '/');

        return sprintf('curl -fsSL "%s/install/%s" | bash', $base, $token);
    }

    public static function seedAuthCommand(string $baseUrl, string $token): string
    {
        $base = rtrim($baseUrl, '/');

        return sprintf('curl -fsSL "%s/seed/auth/%s" | bash', $base, $token);
    }

    public static function installerTokenExpired(array $tokenRow): bool
    {
        $expires = strtotime($tokenRow['expires_at'] ?? '');
        if ($expires === false) {
            return true;
        }

        return $expires < time();
    }

    public static function seedAuthTokenExpired(array $tokenRow): bool
    {
        $expires = strtotime($tokenRow['expires_at'] ?? '');
        if ($expires === false) {
            return true;
        }

        return $expires < time();
    }

    public static function emitInstaller(string $body, int $status = 200, ?string $expiresAt = null): void
    {
        http_response_code($status);
        header('Content-Type: text/x-shellscript; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store, must-revalidate');
        if ($expiresAt !== null) {
            header('X-Installer-Expires-At: ' . $expiresAt);
        }
        echo $body;
        exit;
    }

    public static function emitSeedScript(string $body, int $status = 200, ?string $expiresAt = null): void
    {
        http_response_code($status);
        header('Content-Type: text/x-shellscript; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store, must-revalidate');
        if ($expiresAt !== null) {
            header('X-Seed-Expires-At: ' . $expiresAt);
        }
        echo $body;
        exit;
    }

    public static function installerError(string $message, int $status = 400, ?string $expiresAt = null): void
    {
        self::emitInstaller('echo "' . addslashes($message) . "\" >&2\nexit 1\n", $status, $expiresAt);
    }

    public static function seedAuthError(string $message, int $status = 400, ?string $expiresAt = null): void
    {
        self::emitSeedScript('echo "' . addslashes($message) . "\" >&2\nexit 1\n", $status, $expiresAt);
    }
}
