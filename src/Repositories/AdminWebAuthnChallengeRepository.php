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

class AdminWebAuthnChallengeRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function create(string $challenge, ?int $userId, string $type, string $expiresAt): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO admin_webauthn_challenges (challenge, user_id, type, expires_at, created_at)
             VALUES (:challenge, :user_id, :type, :expires_at, :created_at)'
        );

        $statement->execute([
            'challenge' => $challenge,
            'user_id' => $userId,
            'type' => $type,
            'expires_at' => $expiresAt,
            'created_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        $statement = $this->database->connection()->prepare(
            'SELECT id, challenge, user_id, type, expires_at, created_at
             FROM admin_webauthn_challenges WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: [];
    }

    /**
     * Atomically find a valid (non-expired) challenge and delete it.
     * Returns the row if valid, null otherwise. Single-use: the challenge is consumed.
     */
    public function consume(string $challenge, string $now): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, challenge, user_id, type, expires_at, created_at
             FROM admin_webauthn_challenges
             WHERE challenge = :challenge AND expires_at > :now
             LIMIT 1'
        );
        $statement->execute(['challenge' => $challenge, 'now' => $now]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            return null;
        }

        $del = $this->database->connection()->prepare(
            'DELETE FROM admin_webauthn_challenges WHERE id = :id'
        );
        $del->execute(['id' => $row['id']]);

        return $row;
    }

    public function purgeExpired(string $now): int
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM admin_webauthn_challenges WHERE expires_at <= :now'
        );
        $statement->execute(['now' => $now]);
        return $statement->rowCount();
    }
}
