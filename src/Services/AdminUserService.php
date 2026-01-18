<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\HttpException;
use App\Exceptions\ValidationException;
use App\Repositories\AdminPasswordResetRepository;
use App\Repositories\AdminSessionRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\LogRepository;

class AdminUserService
{
    public function __construct(
        private readonly AdminUserRepository $users,
        private readonly AdminSessionRepository $sessions,
        private readonly AdminPasswordResetRepository $resets,
        private readonly LogRepository $logs,
        private readonly AdminAuthService $auth
    ) {
    }

    public function listUsers(): array
    {
        $rows = $this->users->all();
        return array_map([$this->auth, 'sanitizeUser'], $rows);
    }

    public function createUser(array $payload): array
    {
        $name = $this->requireString($payload, 'name');
        $username = $this->normalizeUsername($this->requireString($payload, 'username'));
        $email = $this->normalizeEmail($this->requireString($payload, 'email'));
        $access = $this->requireString($payload, 'access_level');
        $active = $this->normalizeBool($payload['active'] ?? true);
        $password = (string) ($payload['password'] ?? '');

        if (!$this->auth->validRole($access)) {
            throw new ValidationException(['access_level' => 'Invalid access level']);
        }

        if ($this->users->countUsers() === 0 && $access !== AdminAuthService::ROLE_ADMIN) {
            throw new ValidationException(['access_level' => 'First user must be an admin']);
        }

        if ($active === false && $this->users->countUsers() === 0) {
            throw new ValidationException(['active' => 'First user must be active']);
        }

        $this->auth->validatePassword($password);

        $existing = $this->users->findByUsername($username);
        if ($existing !== null) {
            throw new ValidationException(['username' => 'Username already exists']);
        }

        $existingEmail = $this->users->findByEmail($email);
        if ($existingEmail !== null) {
            throw new ValidationException(['email' => 'Email already exists']);
        }

        $created = $this->users->create([
            'name' => $name,
            'username' => $username,
            'email' => $email,
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'access_level' => $access,
            'active' => $active,
        ]);

        $this->logs->log(null, 'admin.user.create', ['user_id' => $created['id'] ?? null, 'username' => $username]);

        return $this->auth->sanitizeUser($created);
    }

    public function updateUser(int $id, array $payload): array
    {
        $user = $this->users->findById($id);
        if ($user === null) {
            throw new HttpException('User not found', 404);
        }

        $updates = [];
        $errors = [];

        if (array_key_exists('name', $payload)) {
            $updates['name'] = $this->requireString($payload, 'name');
        }

        if (array_key_exists('username', $payload)) {
            $username = $this->normalizeUsername($this->requireString($payload, 'username'));
            $existing = $this->users->findByUsername($username);
            if ($existing !== null && (int) $existing['id'] !== $id) {
                $errors['username'] = 'Username already exists';
            } else {
                $updates['username'] = $username;
            }
        }

        if (array_key_exists('email', $payload)) {
            $email = $this->normalizeEmail($this->requireString($payload, 'email'));
            $existingEmail = $this->users->findByEmail($email);
            if ($existingEmail !== null && (int) $existingEmail['id'] !== $id) {
                $errors['email'] = 'Email already exists';
            } else {
                $updates['email'] = $email;
            }
        }

        if (array_key_exists('access_level', $payload)) {
            $access = (string) $payload['access_level'];
            if (!$this->auth->validRole($access)) {
                $errors['access_level'] = 'Invalid access level';
            } else {
                $updates['access_level'] = $access;
            }
        }

        if (array_key_exists('active', $payload)) {
            $updates['active'] = $this->normalizeBool($payload['active']);
        }

        if (array_key_exists('password', $payload)) {
            $password = (string) $payload['password'];
            $this->auth->validatePassword($password);
            $updates['password_hash'] = password_hash($password, PASSWORD_DEFAULT);
            $this->sessions->deleteByUser($id);
            $this->resets->expireForUser($id, gmdate(DATE_ATOM));
        }

        if ($errors) {
            throw new ValidationException($errors);
        }

        $this->guardLastAdmin($user, $updates);

        $updated = $this->users->update($id, $updates);
        if ($updated === null) {
            throw new HttpException('User not found', 404);
        }

        $this->logs->log(null, 'admin.user.update', ['user_id' => $id]);

        return $this->auth->sanitizeUser($updated);
    }

    public function deleteUser(int $id): void
    {
        $user = $this->users->findById($id);
        if ($user === null) {
            throw new HttpException('User not found', 404);
        }

        $this->guardLastAdmin($user, ['active' => false, 'access_level' => AdminAuthService::ROLE_USER], true);

        $this->sessions->deleteByUser($id);
        $this->resets->expireForUser($id, gmdate(DATE_ATOM));
        $this->users->delete($id);

        $this->logs->log(null, 'admin.user.delete', ['user_id' => $id, 'username' => $user['username'] ?? null]);
    }

    public function wipeAllUsers(): void
    {
        $this->sessions->wipeAll();
        $this->resets->wipeAll();
        $this->users->wipeAll();
        $this->logs->log(null, 'admin.user.wipe', []);
    }

    private function guardLastAdmin(array $user, array $updates, bool $deleting = false): void
    {
        $wasAdmin = ($user['access_level'] ?? '') === AdminAuthService::ROLE_ADMIN;
        $wasActive = !empty($user['active']);
        if (!$wasAdmin || !$wasActive) {
            return;
        }

        $nextRole = $updates['access_level'] ?? $user['access_level'];
        $nextActive = array_key_exists('active', $updates) ? (bool) $updates['active'] : $wasActive;
        $willRemoveAdmin = $deleting || $nextRole !== AdminAuthService::ROLE_ADMIN || !$nextActive;

        if (!$willRemoveAdmin) {
            return;
        }

        if ($this->users->countAdmins(true) <= 1) {
            throw new ValidationException(['access_level' => 'At least one active admin is required']);
        }
    }

    private function requireString(array $payload, string $key): string
    {
        $value = $payload[$key] ?? '';
        if (!is_string($value) || trim($value) === '') {
            throw new ValidationException([$key => 'Required']);
        }
        return trim($value);
    }

    private function normalizeUsername(string $username): string
    {
        $normalized = strtolower(trim($username));
        if ($normalized === '' || !preg_match('/^[a-z0-9._-]{3,64}$/', $normalized)) {
            throw new ValidationException(['username' => 'Username must be 3-64 chars (letters, numbers, . _ -)']);
        }
        return $normalized;
    }

    private function normalizeEmail(string $email): string
    {
        $normalized = strtolower(trim($email));
        if ($normalized === '' || filter_var($normalized, FILTER_VALIDATE_EMAIL) === false) {
            throw new ValidationException(['email' => 'Invalid email']);
        }
        return $normalized;
    }

    private function normalizeBool(mixed $value): bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value !== 0;
        }
        if (is_string($value)) {
            $normalized = strtolower(trim($value));
            return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
        }
        return false;
    }
}
