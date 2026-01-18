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

class AdminPasswordResetRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function create(int $userId, string $tokenHash, string $expiresAt): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO admin_password_resets (user_id, token_hash, expires_at, used_at, created_at)
             VALUES (:user_id, :token_hash, :expires_at, NULL, :created_at)'
        );
        $statement->execute([
            'user_id' => $userId,
            'token_hash' => $tokenHash,
            'expires_at' => $expiresAt,
            'created_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        return $this->findById($id) ?? [];
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, token_hash, expires_at, used_at, created_at
             FROM admin_password_resets WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findActiveByTokenHash(string $tokenHash, string $now): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, token_hash, expires_at, used_at, created_at
             FROM admin_password_resets
             WHERE token_hash = :token_hash AND used_at IS NULL AND expires_at > :now
             LIMIT 1'
        );
        $statement->execute([
            'token_hash' => $tokenHash,
            'now' => $now,
        ]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function markUsed(int $id, string $usedAt): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_password_resets SET used_at = :used_at WHERE id = :id'
        );
        $statement->execute([
            'used_at' => $usedAt,
            'id' => $id,
        ]);
    }

    public function expireForUser(int $userId, string $usedAt): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_password_resets SET used_at = :used_at WHERE user_id = :user_id AND used_at IS NULL'
        );
        $statement->execute([
            'used_at' => $usedAt,
            'user_id' => $userId,
        ]);
    }

    public function wipeAll(): void
    {
        $this->database->connection()->exec('DELETE FROM admin_password_resets');
    }
}
