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
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminPasswordResetRepository;
use App\Repositories\AdminSessionRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\LogRepository;
use App\Support\Mailer;

class AdminAuthService
{
    public const ROLE_ADMIN = 'admin';
    public const ROLE_FLEET = 'fleet_operator';
    public const ROLE_TRUSTED = 'trusted_user';
    public const ROLE_USER = 'user';

    public const CAP_USERS_MANAGE = 'users.manage';
    public const CAP_SETTINGS = 'settings.manage';
    public const CAP_HOSTS_MANAGE = 'hosts.manage';
    public const CAP_HOSTS_ACTIVATE = 'hosts.activate';

    private const ROLE_LABELS = [
        self::ROLE_ADMIN => 'Admin',
        self::ROLE_FLEET => 'Fleet Operator',
        self::ROLE_TRUSTED => 'Trusted User',
        self::ROLE_USER => 'User',
    ];

    public function __construct(
        private readonly AdminUserRepository $users,
        private readonly AdminSessionRepository $sessions,
        private readonly AdminPasswordResetRepository $resets,
        private readonly LogRepository $logs,
        private readonly Mailer $mailer,
        private readonly ?AdminPasskeyRepository $passkeys = null
    ) {
    }

    public function isEnforced(): bool
    {
        return $this->users->countAdmins(true) > 0;
    }

    public function sessionCookieName(): string
    {
        $raw = Config::get('ADMIN_SESSION_COOKIE', 'codex_admin_session');
        return is_string($raw) && trim($raw) !== '' ? trim($raw) : 'codex_admin_session';
    }

    public function sessionTtlSeconds(): int
    {
        $raw = Config::get('ADMIN_SESSION_TTL_SECONDS', 28800);
        $ttl = is_numeric($raw) ? (int) $raw : 28800;
        if ($ttl < 300) {
            $ttl = 300;
        }
        if ($ttl > 604800) {
            $ttl = 604800;
        }
        return $ttl;
    }

    public function passwordMinLength(): int
    {
        $raw = Config::get('ADMIN_PASSWORD_MIN_LENGTH', 12);
        $min = is_numeric($raw) ? (int) $raw : 12;
        return max(8, min(128, $min));
    }

    public function roleLabels(): array
    {
        return self::ROLE_LABELS;
    }

    public function validRole(string $role): bool
    {
        return array_key_exists($role, self::ROLE_LABELS);
    }

    public function login(string $username, string $password, ?string $ip, ?string $userAgent): array
    {
        if (trim($password) === '') {
            throw new HttpException('Invalid credentials', 401);
        }

        $user = $this->resolveLoginUser($username);
        if ($this->requiresPasskey($user)) {
            throw new HttpException('Passkey login required for this user', 403);
        }

        $hash = (string) ($user['password_hash'] ?? '');
        if ($hash === '' || !password_verify($password, $hash)) {
            throw new HttpException('Invalid credentials', 401);
        }
        if (password_needs_rehash($hash, PASSWORD_DEFAULT)) {
            $rehash = password_hash($password, PASSWORD_DEFAULT);
            $this->users->update((int) $user['id'], ['password_hash' => $rehash]);
            $user['password_hash'] = $rehash;
        }

        return $this->createSessionForUser($user, $ip, $userAgent, 'admin.auth.login');
    }

    public function resolveLoginMethod(string $username): string
    {
        $user = $this->resolveLoginUser($username);
        return $this->requiresPasskey($user) ? 'passkey' : 'password';
    }

    public function createSessionForUser(array $user, ?string $ip, ?string $userAgent, string $logEvent = 'admin.auth.login'): array
    {
        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $expiresAt = gmdate(DATE_ATOM, time() + $this->sessionTtlSeconds());
        $this->sessions->create((int) $user['id'], $tokenHash, $expiresAt, $ip, $userAgent);
        $this->users->updateLastLogin((int) $user['id'], gmdate(DATE_ATOM));
        $this->logs->log(null, $logEvent, ['user_id' => $user['id'], 'username' => $user['username'] ?? '']);

        return [
            'token' => $token,
            'expires_at' => $expiresAt,
            'user' => $this->sanitizeUser($user),
        ];
    }

    public function resolveSession(?string $token): ?array
    {
        if ($token === null || $token === '') {
            return null;
        }

        $tokenHash = hash('sha256', $token);
        $session = $this->sessions->findByTokenHash($tokenHash);
        if ($session === null) {
            return null;
        }

        $expires = strtotime((string) ($session['expires_at'] ?? ''));
        if ($expires === false || $expires <= time()) {
            $this->sessions->deleteByTokenHash($tokenHash);
            return null;
        }

        $user = $this->users->findById((int) $session['user_id']);
        if ($user === null || empty($user['active'])) {
            $this->sessions->deleteByTokenHash($tokenHash);
            return null;
        }

        $this->sessions->touch((int) $session['id'], gmdate(DATE_ATOM));

        return [
            'session' => $session,
            'user' => $this->sanitizeUser($user),
        ];
    }

    public function logout(?string $token): void
    {
        if ($token === null || $token === '') {
            return;
        }
        $this->sessions->deleteByTokenHash(hash('sha256', $token));
        $this->logs->log(null, 'admin.auth.logout', []);
    }

    public function changePassword(int $userId, string $currentPassword, string $newPassword, ?string $currentToken = null): array
    {
        $user = $this->users->findById($userId);
        if ($user === null || empty($user['active'])) {
            throw new HttpException('User not found', 404);
        }

        $hash = (string) ($user['password_hash'] ?? '');
        if ($hash === '' || trim($currentPassword) === '' || !password_verify($currentPassword, $hash)) {
            throw new HttpException('Current password is incorrect', 401);
        }

        $this->validatePassword($newPassword);

        $nextHash = password_hash($newPassword, PASSWORD_DEFAULT);
        $updated = $this->users->update($userId, ['password_hash' => $nextHash]);
        if ($updated === null) {
            throw new HttpException('User not found', 404);
        }

        if (is_string($currentToken) && trim($currentToken) !== '') {
            $this->sessions->deleteByUserExceptTokenHash($userId, hash('sha256', $currentToken));
        } else {
            $this->sessions->deleteByUser($userId);
        }
        $this->resets->expireForUser($userId, gmdate(DATE_ATOM));
        $this->logs->log(null, 'admin.auth.password.change', ['user_id' => $userId]);

        return $this->sanitizeUser($updated);
    }

    public function assertCapability(array $user, string $capability): void
    {
        $role = (string) ($user['access_level'] ?? self::ROLE_USER);
        if ($this->roleAllows($role, $capability)) {
            return;
        }
        throw new HttpException('Forbidden', 403);
    }

    public function enforceCapability(?array $user, string $capability): void
    {
        if (!$this->isEnforced()) {
            return;
        }
        if ($user === null) {
            throw new HttpException('Authentication required', 401);
        }
        $this->assertCapability($user, $capability);
    }

    public function roleAllows(string $role, string $capability): bool
    {
        if ($role === self::ROLE_ADMIN) {
            return true;
        }

        $matrix = [
            self::ROLE_FLEET => [self::CAP_SETTINGS, self::CAP_HOSTS_MANAGE, self::CAP_HOSTS_ACTIVATE],
            self::ROLE_TRUSTED => [self::CAP_HOSTS_ACTIVATE],
            self::ROLE_USER => [],
        ];

        return in_array($capability, $matrix[$role] ?? [], true);
    }

    public function validatePassword(string $password): void
    {
        $min = $this->passwordMinLength();
        if (strlen($password) < $min) {
            throw new ValidationException(['password' => 'Password must be at least ' . $min . ' characters.']);
        }
    }

    public function sanitizeUser(array $user): array
    {
        return [
            'id' => (int) ($user['id'] ?? 0),
            'name' => $user['name'] ?? '',
            'username' => $user['username'] ?? '',
            'email' => $user['email'] ?? '',
            'access_level' => $user['access_level'] ?? self::ROLE_USER,
            'active' => (bool) ($user['active'] ?? false),
            'last_login_at' => $user['last_login_at'] ?? null,
            'created_at' => $user['created_at'] ?? null,
            'updated_at' => $user['updated_at'] ?? null,
        ];
    }

    private function resolveLoginUser(string $username): array
    {
        $username = trim($username);
        if ($username === '') {
            throw new HttpException('Invalid credentials', 401);
        }

        $user = $this->users->findByUsername(strtolower($username));
        if ($user === null || empty($user['active'])) {
            throw new HttpException('Invalid credentials', 401);
        }

        return $user;
    }

    private function requiresPasskey(array $user): bool
    {
        if (!$this->passkeys instanceof AdminPasskeyRepository) {
            return false;
        }

        return $this->passkeys->countForUser((int) ($user['id'] ?? 0)) > 0;
    }
}
