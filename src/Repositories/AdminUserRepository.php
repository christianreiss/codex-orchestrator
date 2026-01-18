<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use PDO;

class AdminUserRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function countUsers(): int
    {
        $statement = $this->database->connection()->query('SELECT COUNT(*) AS total FROM admin_users');
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return (int) ($row['total'] ?? 0);
    }

    public function countAdmins(bool $onlyActive = true): int
    {
        $sql = 'SELECT COUNT(*) AS total FROM admin_users WHERE access_level = :role';
        if ($onlyActive) {
            $sql .= ' AND active = 1';
        }
        $statement = $this->database->connection()->prepare($sql);
        $statement->execute([
            'role' => 'admin',
        ]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return (int) ($row['total'] ?? 0);
    }

    public function all(): array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, name, username, email, access_level, active, last_login_at, created_at, updated_at
             FROM admin_users ORDER BY username ASC'
        );
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        return is_array($rows) ? $rows : [];
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, name, username, email, password_hash, access_level, active, last_login_at, created_at, updated_at
             FROM admin_users WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findByUsername(string $username): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, name, username, email, password_hash, access_level, active, last_login_at, created_at, updated_at
             FROM admin_users WHERE username = :username LIMIT 1'
        );
        $statement->execute(['username' => $username]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findByEmail(string $email): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, name, username, email, password_hash, access_level, active, last_login_at, created_at, updated_at
             FROM admin_users WHERE email = :email LIMIT 1'
        );
        $statement->execute(['email' => $email]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function create(array $payload): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO admin_users (name, username, email, password_hash, access_level, active, created_at, updated_at)
             VALUES (:name, :username, :email, :password_hash, :access_level, :active, :created_at, :updated_at)'
        );

        $statement->execute([
            'name' => $payload['name'],
            'username' => $payload['username'],
            'email' => $payload['email'],
            'password_hash' => $payload['password_hash'],
            'access_level' => $payload['access_level'],
            'active' => $payload['active'] ? 1 : 0,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        $user = $this->findById($id);
        return $user ?? [];
    }

    public function update(int $id, array $payload): ?array
    {
        $fields = [];
        $params = ['id' => $id];

        foreach (['name', 'username', 'email', 'access_level'] as $key) {
            if (array_key_exists($key, $payload)) {
                $fields[] = $key . ' = :' . $key;
                $params[$key] = $payload[$key];
            }
        }

        if (array_key_exists('active', $payload)) {
            $fields[] = 'active = :active';
            $params['active'] = $payload['active'] ? 1 : 0;
        }

        if (array_key_exists('password_hash', $payload)) {
            $fields[] = 'password_hash = :password_hash';
            $params['password_hash'] = $payload['password_hash'];
        }

        if (!$fields) {
            return $this->findById($id);
        }

        $fields[] = 'updated_at = :updated_at';
        $params['updated_at'] = gmdate(DATE_ATOM);

        $statement = $this->database->connection()->prepare(
            'UPDATE admin_users SET ' . implode(', ', $fields) . ' WHERE id = :id'
        );
        $statement->execute($params);

        return $this->findById($id);
    }

    public function delete(int $id): void
    {
        $statement = $this->database->connection()->prepare('DELETE FROM admin_users WHERE id = :id');
        $statement->execute(['id' => $id]);
    }

    public function updateLastLogin(int $id, string $timestamp): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_users SET last_login_at = :last_login_at, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'last_login_at' => $timestamp,
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function wipeAll(): void
    {
        $this->database->connection()->exec('DELETE FROM admin_users');
    }
}
