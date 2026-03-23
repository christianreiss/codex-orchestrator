<?php

namespace App\Http;

use App\Config;
use App\Exceptions\HttpException;
use App\Services\AdminAuthService;

final class AdminSessionHelper
{
    public static function adminAccessMode(): string
    {
        $mode = Config::get('ADMIN_ACCESS_MODE', 'mtls');
        $normalized = strtolower(trim((string) $mode));
        return $normalized === 'none' ? 'none' : 'mtls';
    }

    public static function resolveAdminSessionToken(AdminAuthService $adminAuthService): ?string
    {
        $cookieName = $adminAuthService->sessionCookieName();
        $token = $_COOKIE[$cookieName] ?? null;
        if (!is_string($token)) {
            return null;
        }
        $token = trim($token);
        return $token === '' ? null : $token;
    }

    public static function resolveAdminSession(AdminAuthService $adminAuthService): ?array
    {
        if (array_key_exists('admin_auth_session', $GLOBALS)) {
            $cached = $GLOBALS['admin_auth_session'];
            return is_array($cached) ? $cached : null;
        }

        $session = $adminAuthService->resolveSession(self::resolveAdminSessionToken($adminAuthService));
        $GLOBALS['admin_auth_session'] = $session;
        return $session;
    }

    public static function requireAdminAccess(): void
    {
        $mode = self::adminAccessMode();
        $mtlsOk = SecurityHelper::isMtlsSatisfied();
        $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
        $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?? '/';

        $mtlsRequired = $mode === 'mtls';

        if ($mtlsRequired && !$mtlsOk) {
            Response::json([
                'status' => 'error',
                'message' => 'Client certificate required for admin access',
            ], 403);
        }

        $adminAuthService = $GLOBALS['adminAuthService'] ?? null;
        if (!$adminAuthService instanceof AdminAuthService) {
            return;
        }

        if (!$adminAuthService->isEnforced()) {
            return;
        }

        $path = rtrim($path, '/');
        if ($path === '') {
            $path = '/';
        }
        $bypass = [
            '/admin/auth/status',
            '/admin/auth/login',
            '/admin/auth/login/method',
            '/admin/auth/logout',
            '/admin/auth/password/request',
            '/admin/auth/password/reset',
            '/admin/auth/passkey/login/options',
            '/admin/auth/passkey/login',
        ];
        if (in_array($path, $bypass, true)) {
            return;
        }

        $session = self::resolveAdminSession($adminAuthService);
        if ($session === null || !isset($session['user'])) {
            Response::json([
                'status' => 'error',
                'message' => 'Authentication required',
            ], 401);
        }

        $GLOBALS['adminAuthUser'] = $session['user'];
    }

    public static function requireAdminCapability(string $capability): void
    {
        $adminAuthService = $GLOBALS['adminAuthService'] ?? null;
        if (!$adminAuthService instanceof AdminAuthService) {
            return;
        }
        if (!$adminAuthService->isEnforced()) {
            return;
        }

        $session = self::resolveAdminSession($adminAuthService);
        try {
            $adminAuthService->enforceCapability($session['user'] ?? null, $capability);
        } catch (HttpException $exception) {
            Response::json([
                'status' => 'error',
                'message' => $exception->getMessage(),
            ], $exception->getStatusCode());
        }
    }

    public static function adminWebAuthnRpId(): string
    {
        $configured = Config::get('ADMIN_WEBAUTHN_RP_ID', '');
        if (is_string($configured) && trim($configured) !== '') {
            return trim($configured);
        }

        $publicBase = RequestHelper::normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''));
        if ($publicBase !== '') {
            $host = parse_url($publicBase, PHP_URL_HOST);
            if (is_string($host) && trim($host) !== '') {
                return trim($host);
            }
        }

        $host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
        if (!is_string($host)) {
            return 'localhost';
        }
        return preg_replace('/:\d+$/', '', $host);
    }

    public static function adminWebAuthnRpName(): string
    {
        $configured = Config::get('ADMIN_WEBAUTHN_RP_NAME', '');
        if (is_string($configured) && trim($configured) !== '') {
            return trim($configured);
        }
        return 'Codex Orchestrator';
    }

    public static function adminWebAuthnOrigin(): string
    {
        $configured = Config::get('ADMIN_WEBAUTHN_ORIGIN', '');
        if (is_string($configured) && trim($configured) !== '') {
            $normalized = CorsHelper::normalizeOrigin($configured);
            if ($normalized !== null) {
                return $normalized;
            }
        }

        $publicBase = RequestHelper::normalizeBaseUrlCandidate((string) Config::get('PUBLIC_BASE_URL', ''));
        if ($publicBase !== '') {
            $publicOrigin = CorsHelper::normalizeOrigin($publicBase);
            if ($publicOrigin !== null) {
                return $publicOrigin;
            }
        }

        $origin = CorsHelper::resolveRequestOrigin();
        if ($origin !== null) {
            return $origin;
        }

        $scheme = RequestHelper::resolveRequestScheme();
        $host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
        if (!is_string($host) || trim($host) === '') {
            $host = 'localhost';
        }
        return CorsHelper::normalizeOrigin($scheme . '://' . trim($host)) ?? ($scheme . '://' . trim($host));
    }
}
