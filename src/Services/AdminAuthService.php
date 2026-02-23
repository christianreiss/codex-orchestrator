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
        private readonly Mailer $mailer
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

    public function resetTtlSeconds(): int
    {
        $raw = Config::get('ADMIN_PASSWORD_RESET_TTL_SECONDS', 3600);
        $ttl = is_numeric($raw) ? (int) $raw : 3600;
        if ($ttl < 300) {
            $ttl = 300;
        }
        if ($ttl > 86400) {
            $ttl = 86400;
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
        $username = trim($username);
        if ($username === '' || $password === '') {
            throw new HttpException('Invalid credentials', 401);
        }

        $user = $this->users->findByUsername(strtolower($username));
        if ($user === null || empty($user['active'])) {
            throw new HttpException('Invalid credentials', 401);
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

        $token = bin2hex(random_bytes(32));
        $tokenHash = hash('sha256', $token);
        $expiresAt = gmdate(DATE_ATOM, time() + $this->sessionTtlSeconds());
        $this->sessions->create((int) $user['id'], $tokenHash, $expiresAt, $ip, $userAgent);
        $this->users->updateLastLogin((int) $user['id'], gmdate(DATE_ATOM));
        $this->logs->log(null, 'admin.auth.login', ['user_id' => $user['id'], 'username' => $user['username']]);

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

    public function requestPasswordReset(string $identity): void
    {
        $identity = trim($identity);
        if ($identity === '') {
            return;
        }

        $user = $this->users->findByUsername(strtolower($identity));
        if ($user === null) {
            $user = $this->users->findByEmail(strtolower($identity));
        }

        if ($user === null || empty($user['active'])) {
            return;
        }

        $fromEmail = (string) Config::get('ADMIN_PASSWORD_RESET_FROM', '');
        $fromName = (string) Config::get('ADMIN_PASSWORD_RESET_FROM_NAME', '');
        if (trim($fromEmail) === '') {
            throw new HttpException('Password recovery not configured', 501);
        }

        $token = bin2hex(random_bytes(24));
        $tokenHash = hash('sha256', $token);
        $expiresAt = gmdate(DATE_ATOM, time() + $this->resetTtlSeconds());
        $this->resets->expireForUser((int) $user['id'], gmdate(DATE_ATOM));
        $this->resets->create((int) $user['id'], $tokenHash, $expiresAt);

        $base = (string) Config::get('ADMIN_PASSWORD_RESET_BASE_URL', '');
        if (trim($base) === '') {
            $base = (string) Config::get('PUBLIC_BASE_URL', '');
        }
        $base = rtrim(trim($base), '/');
        $link = $base !== '' ? $base . '/admin/#reset?token=' . $token : '';

        $body = "A password reset was requested for your Codex Orchestrator admin account.\n\n";
        if ($link !== '') {
            $body .= "Reset link: {$link}\n";
        }
        $body .= "Reset token: {$token}\n";
        $body .= "This token expires at {$expiresAt} UTC.\n";

        $sent = $this->mailer->send((string) $user['email'], 'Codex Orchestrator password reset', $body, $fromEmail, $fromName);
        if (!$sent) {
            throw new HttpException('Failed to send password recovery email', 500);
        }

        $this->logs->log(null, 'admin.auth.reset.request', ['user_id' => $user['id']]);
    }

    public function resetPassword(string $token, string $newPassword): array
    {
        $this->validatePassword($newPassword);
        $token = trim($token);
        if ($token === '') {
            throw new ValidationException(['token' => 'Reset token is required']);
        }

        $tokenHash = hash('sha256', $token);
        $reset = $this->resets->findActiveByTokenHash($tokenHash, gmdate(DATE_ATOM));
        if ($reset === null) {
            throw new HttpException('Invalid or expired reset token', 400);
        }

        $user = $this->users->findById((int) $reset['user_id']);
        if ($user === null) {
            throw new HttpException('User not found', 404);
        }

        $hash = password_hash($newPassword, PASSWORD_DEFAULT);
        $this->users->update((int) $user['id'], ['password_hash' => $hash]);
        $this->resets->markUsed((int) $reset['id'], gmdate(DATE_ATOM));
        $this->sessions->deleteByUser((int) $user['id']);

        $this->logs->log(null, 'admin.auth.reset.complete', ['user_id' => $user['id']]);

        return $this->sanitizeUser($user);
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
}
