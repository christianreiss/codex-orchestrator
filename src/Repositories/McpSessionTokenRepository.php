<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Repositories;

use App\Database;
use App\Security\SecretBox;
use PDO;

class McpSessionTokenRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $encrypter
    ) {
    }

    public function create(string $token, int $hostId, string $expiresAt): array
    {
        $now = gmdate(DATE_ATOM);
        $tokenHash = hash('sha256', $token);
        $tokenEnc = $this->encrypter->encrypt($token);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO mcp_session_tokens (token, token_enc, host_id, expires_at, created_at, updated_at)
             VALUES (:token, :token_enc, :host_id, :expires_at, :created_at, :updated_at)'
        );

        $statement->execute([
            'token' => $tokenHash,
            'token_enc' => $tokenEnc,
            'host_id' => $hostId,
            'expires_at' => $expiresAt,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findByToken($token) ?? [
            'token' => $token,
            'host_id' => $hostId,
            'expires_at' => $expiresAt,
        ];
    }

    public function findByToken(string $token): ?array
    {
        $tokenHash = hash('sha256', $token);

        $statement = $this->database->connection()->prepare(
            'SELECT * FROM mcp_session_tokens WHERE token = :token LIMIT 1'
        );
        $statement->execute(['token' => $tokenHash]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        $row['token'] = $this->decryptValue($row['token_enc'] ?? null) ?? $token;

        return $row;
    }

    public function touch(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE mcp_session_tokens SET last_used_at = :last_used_at, updated_at = :updated_at WHERE id = :id'
        );
        $statement->execute([
            'last_used_at' => gmdate(DATE_ATOM),
            'updated_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function deleteExpired(string $cutoff): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM mcp_session_tokens WHERE expires_at < :cutoff'
        );
        $statement->execute(['cutoff' => $cutoff]);
    }

    private function decryptValue(?string $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        if (!$this->encrypter->isEncrypted($value)) {
            return $value;
        }

        return $this->encrypter->decrypt($value);
    }
}
