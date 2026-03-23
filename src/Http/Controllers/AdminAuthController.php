<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Exceptions\ValidationException;
use App\Http\Response;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminUserRepository;
use App\Services\AdminAuthService;
use App\Services\AdminPasskeyService;

class AdminAuthController
{
    public function __construct(
        private AdminAuthService $adminAuthService,
        private AdminPasskeyService $adminPasskeyService,
        private AdminUserRepository $adminUserRepository,
        private AdminPasskeyRepository $adminPasskeyRepository,
        private array $payload,
    ) {}

    /** GET /admin/auth/status */
    public function status(): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        $userId = $session['user']['id'] ?? null;
        $passkeyCount = ($userId !== null) ? $this->adminPasskeyRepository->countForUser((int) $userId) : 0;
        Response::json([
            'status' => 'ok',
            'data' => [
                'has_users' => $this->adminUserRepository->countUsers() > 0,
                'admin_count' => $this->adminUserRepository->countAdmins(true),
                'enforced' => $this->adminAuthService->isEnforced(),
                'authenticated' => $session !== null,
                'user' => $session['user'] ?? null,
                'roles' => $this->adminAuthService->roleLabels(),
                'passkeys_registered' => $passkeyCount,
                'passkey_login_available' => $this->adminPasskeyRepository->countAll() > 0,
            ],
        ]);
    }

    /** POST /admin/auth/login */
    public function login(): void
    {
        requireAdminAccess();
        $username = is_array($this->payload) ? (string) ($this->payload['username'] ?? '') : '';
        $password = is_array($this->payload) ? (string) ($this->payload['password'] ?? '') : '';
        $ip = resolveClientIp();
        $userAgent = $_SERVER['HTTP_USER_AGENT'] ?? null;

        $result = $this->adminAuthService->login($username, $password, $ip, is_string($userAgent) ? $userAgent : null);
        $cookieName = $this->adminAuthService->sessionCookieName();
        $expires = strtotime((string) ($result['expires_at'] ?? '')) ?: (time() + $this->adminAuthService->sessionTtlSeconds());
        setcookie($cookieName, $result['token'], [
            'expires' => $expires,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Strict',
            'secure' => isHttpsRequest(),
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'user' => $result['user'],
                'expires_at' => $result['expires_at'],
            ],
        ]);
    }

    /** POST /admin/auth/login/method */
    public function loginMethod(): void
    {
        requireAdminAccess();
        $username = is_array($this->payload) ? (string) ($this->payload['username'] ?? '') : '';

        Response::json([
            'status' => 'ok',
            'data' => [
                'method' => $this->adminAuthService->resolveLoginMethod($username),
            ],
        ]);
    }

    /** POST /admin/auth/logout */
    public function logout(): void
    {
        requireAdminAccess();
        $token = resolveAdminSessionToken($this->adminAuthService);
        $this->adminAuthService->logout($token);
        $cookieName = $this->adminAuthService->sessionCookieName();
        setcookie($cookieName, '', [
            'expires' => time() - 3600,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Strict',
            'secure' => isHttpsRequest(),
        ]);

        Response::json([
            'status' => 'ok',
        ]);
    }

    /** POST /admin/auth/password/change */
    public function passwordChange(): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        if ($session === null || !isset($session['user']['id'])) {
            Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
        }

        $currentPassword = is_array($this->payload) ? (string) ($this->payload['current_password'] ?? '') : '';
        $newPassword = is_array($this->payload) ? (string) ($this->payload['new_password'] ?? '') : '';
        $confirmPassword = is_array($this->payload) ? (string) ($this->payload['confirm_password'] ?? '') : '';
        if ($newPassword !== $confirmPassword) {
            throw new ValidationException(['confirm_password' => 'Password confirmation does not match.']);
        }

        $user = $this->adminAuthService->changePassword(
            (int) $session['user']['id'],
            $currentPassword,
            $newPassword,
            resolveAdminSessionToken($this->adminAuthService)
        );

        Response::json([
            'status' => 'ok',
            'data' => [
                'user' => $user,
            ],
        ]);
    }

    /** POST /admin/auth/password/request */
    public function passwordRequest(): void
    {
        requireAdminAccess();
        Response::json([
            'status' => 'error',
            'message' => 'Password reset is disabled',
        ], 410);
    }

    /** POST /admin/auth/password/reset */
    public function passwordReset(): void
    {
        requireAdminAccess();
        Response::json([
            'status' => 'error',
            'message' => 'Password reset is disabled',
        ], 410);
    }

    // --- Passkey login (unauthenticated) ---

    /** POST /admin/auth/passkey/login/options */
    public function passkeyLoginOptions(): void
    {
        requireAdminAccess();
        $username = is_array($this->payload) ? (string) ($this->payload['username'] ?? '') : '';
        $rpId = adminWebAuthnRpId();
        $options = $this->adminPasskeyService->beginAuthentication($username, $rpId);
        Response::json(['status' => 'ok', 'data' => $options]);
    }

    /** POST /admin/auth/passkey/login */
    public function passkeyLogin(): void
    {
        requireAdminAccess();
        $rpId = adminWebAuthnRpId();
        $origin = adminWebAuthnOrigin();
        $user = $this->adminPasskeyService->completeAuthentication(
            is_array($this->payload) ? $this->payload : [],
            $rpId,
            $origin
        );

        $result = $this->adminAuthService->createSessionForUser(
            $user,
            resolveClientIp(),
            is_string($_SERVER['HTTP_USER_AGENT'] ?? null) ? $_SERVER['HTTP_USER_AGENT'] : null,
            'admin.auth.passkey.login'
        );

        $cookieName = $this->adminAuthService->sessionCookieName();
        $expires = strtotime((string) ($result['expires_at'] ?? '')) ?: (time() + $this->adminAuthService->sessionTtlSeconds());
        setcookie($cookieName, $result['token'], [
            'expires' => $expires,
            'path' => '/',
            'httponly' => true,
            'samesite' => 'Strict',
            'secure' => isHttpsRequest(),
        ]);

        Response::json([
            'status' => 'ok',
            'data' => [
                'user' => $result['user'],
                'expires_at' => $result['expires_at'],
            ],
        ]);
    }

    // --- Passkey registration (authenticated) ---

    /** POST /admin/auth/passkey/register/options */
    public function passkeyRegisterOptions(): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        if ($session === null || !isset($session['user'])) {
            Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
        }
        $rpId = adminWebAuthnRpId();
        $rpName = adminWebAuthnRpName();
        $options = $this->adminPasskeyService->beginRegistration($session['user'], $rpId, $rpName);
        Response::json(['status' => 'ok', 'data' => $options]);
    }

    /** POST /admin/auth/passkey/register */
    public function passkeyRegister(): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        if ($session === null || !isset($session['user'])) {
            Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
        }
        $rpId = adminWebAuthnRpId();
        $origin = adminWebAuthnOrigin();
        $passkey = $this->adminPasskeyService->completeRegistration(
            $session['user'],
            is_array($this->payload) ? $this->payload : [],
            $rpId,
            $origin
        );
        Response::json(['status' => 'ok', 'data' => ['passkey' => $passkey]]);
    }

    // --- Passkey management (authenticated) ---

    /** GET /admin/passkeys */
    public function passkeyList(): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        if ($session === null || !isset($session['user'])) {
            Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
        }
        $passkeys = $this->adminPasskeyService->listForUser((int) $session['user']['id']);
        Response::json(['status' => 'ok', 'data' => ['passkeys' => $passkeys]]);
    }

    /** POST /admin/passkeys/{id}/name */
    public function passkeyRename(string $id): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        if ($session === null || !isset($session['user'])) {
            Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
        }
        $name = is_array($this->payload) ? trim((string) ($this->payload['name'] ?? '')) : '';
        if ($name === '') {
            Response::json(['status' => 'error', 'message' => 'Name is required'], 422);
        }
        $this->adminPasskeyService->updatePasskeyName((int) $id, (int) $session['user']['id'], $name);
        Response::json(['status' => 'ok']);
    }

    /** DELETE /admin/passkeys/{id} */
    public function passkeyDelete(string $id): void
    {
        requireAdminAccess();
        $session = resolveAdminSession($this->adminAuthService);
        if ($session === null || !isset($session['user'])) {
            Response::json(['status' => 'error', 'message' => 'Authentication required'], 401);
        }
        $this->adminPasskeyService->deletePasskey((int) $id, (int) $session['user']['id']);
        Response::json(['status' => 'ok']);
    }
}
