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

class InstallTokenRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $encrypter
    )
    {
    }

    public function create(string $token, int $hostId, string $apiKey, string $fqdn, string $expiresAt, ?string $baseUrl = null): array
    {
        $now = gmdate(DATE_ATOM);
        $tokenHash = hash('sha256', $token);
        $tokenEnc = $this->encrypter->encrypt($token);
        $apiKeyHash = hash('sha256', $apiKey);
        $apiKeyEnc = $this->encrypter->encrypt($apiKey);

        // Ensure only one pending token per host to avoid accidental host churn on reinstall.
        $delete = $this->database->connection()->prepare('DELETE FROM install_tokens WHERE host_id = :host_id');
        $delete->execute(['host_id' => $hostId]);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO install_tokens (token, token_enc, host_id, api_key, api_key_enc, fqdn, base_url, expires_at, created_at)
             VALUES (:token, :token_enc, :host_id, :api_key, :api_key_enc, :fqdn, :base_url, :expires_at, :created_at)'
        );

        $statement->execute([
            'token' => $tokenHash,
            'token_enc' => $tokenEnc,
            'host_id' => $hostId,
            'api_key' => $apiKeyHash,
            'api_key_enc' => $apiKeyEnc,
            'fqdn' => $fqdn,
            'base_url' => $baseUrl,
            'expires_at' => $expiresAt,
            'created_at' => $now,
        ]);

        return $this->findByToken($token);
    }

    public function findByToken(string $token): ?array
    {
        $tokenHash = hash('sha256', $token);

        $statement = $this->database->connection()->prepare(
            'SELECT * FROM install_tokens WHERE token = :token LIMIT 1'
        );
        $statement->execute(['token' => $tokenHash]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (!$row) {
            return null;
        }

        $row['token'] = $this->decryptValue($row['token_enc'] ?? null) ?? $token;
        $row['api_key'] = $this->decryptValue($row['api_key_enc'] ?? null) ?? ($row['api_key'] ?? null);

        return $row;
    }

    public function markUsed(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE install_tokens SET used_at = :used_at WHERE id = :id'
        );
        $statement->execute([
            'used_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function deleteExpired(string $cutoff): void
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM install_tokens WHERE expires_at < :cutoff OR used_at IS NOT NULL'
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
