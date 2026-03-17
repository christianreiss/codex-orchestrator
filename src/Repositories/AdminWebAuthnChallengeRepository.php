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
        $connection = $this->database->connection();
        $driver = strtolower((string) $connection->getAttribute(PDO::ATTR_DRIVER_NAME));
        $startedTransaction = false;

        try {
            if ($driver === 'sqlite') {
                $connection->exec('BEGIN IMMEDIATE TRANSACTION');
                $startedTransaction = true;
            } elseif (!$connection->inTransaction()) {
                $connection->beginTransaction();
                $startedTransaction = true;
            }

            $sql = 'SELECT id, challenge, user_id, type, expires_at, created_at
                    FROM admin_webauthn_challenges
                    WHERE challenge = :challenge AND expires_at > :now
                    LIMIT 1';
            if ($driver === 'mysql') {
                $sql .= ' FOR UPDATE';
            }

            $statement = $connection->prepare($sql);
            $statement->execute(['challenge' => $challenge, 'now' => $now]);
            $row = $statement->fetch(PDO::FETCH_ASSOC);

            if (!$row) {
                if ($startedTransaction) {
                    $connection->commit();
                }
                return null;
            }

            $del = $connection->prepare(
                'DELETE FROM admin_webauthn_challenges WHERE id = :id'
            );
            $del->execute(['id' => $row['id']]);

            if ($del->rowCount() !== 1) {
                if ($startedTransaction) {
                    $connection->rollBack();
                }
                return null;
            }

            if ($startedTransaction) {
                $connection->commit();
            }

            return $row;
        } catch (\Throwable $exception) {
            if ($startedTransaction && $connection->inTransaction()) {
                $connection->rollBack();
            }
            throw $exception;
        }
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
