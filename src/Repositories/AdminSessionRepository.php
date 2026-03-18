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

class AdminSessionRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function create(int $userId, string $tokenHash, string $expiresAt, ?string $ip, ?string $userAgent): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO admin_sessions (user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at)
             VALUES (:user_id, :token_hash, :ip, :user_agent, :created_at, :last_seen_at, :expires_at)'
        );

        $statement->execute([
            'user_id' => $userId,
            'token_hash' => $tokenHash,
            'ip' => $ip,
            'user_agent' => $userAgent,
            'created_at' => $now,
            'last_seen_at' => $now,
            'expires_at' => $expiresAt,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        return $this->findById($id) ?? [];
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at
             FROM admin_sessions WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findByTokenHash(string $tokenHash): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, token_hash, ip, user_agent, created_at, last_seen_at, expires_at
             FROM admin_sessions WHERE token_hash = :token_hash LIMIT 1'
        );
        $statement->execute(['token_hash' => $tokenHash]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function touch(int $id, string $timestamp): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_sessions SET last_seen_at = :last_seen_at WHERE id = :id'
        );
        $statement->execute([
            'last_seen_at' => $timestamp,
            'id' => $id,
        ]);
    }

    public function deleteByTokenHash(string $tokenHash): void
    {
        $statement = $this->database->connection()->prepare('DELETE FROM admin_sessions WHERE token_hash = :token_hash');
        $statement->execute(['token_hash' => $tokenHash]);
    }

    public function deleteByUser(int $userId): void
    {
        $statement = $this->database->connection()->prepare('DELETE FROM admin_sessions WHERE user_id = :user_id');
        $statement->execute(['user_id' => $userId]);
    }

    public function deleteByUserExceptTokenHash(int $userId, string $tokenHash): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM admin_sessions WHERE user_id = :user_id AND token_hash <> :token_hash'
        );
        $statement->execute([
            'user_id' => $userId,
            'token_hash' => $tokenHash,
        ]);
    }

    public function purgeExpired(string $now): int
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM admin_sessions WHERE expires_at <= :now'
        );
        $statement->execute(['now' => $now]);
        return $statement->rowCount();
    }

    public function wipeAll(): void
    {
        $this->database->connection()->exec('DELETE FROM admin_sessions');
    }
}
