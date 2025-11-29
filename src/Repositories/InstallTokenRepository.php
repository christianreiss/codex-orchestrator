<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 */

namespace App\Repositories;

use App\Database;
use PDO;

class InstallTokenRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function create(string $token, int $hostId, string $apiKey, string $fqdn, string $expiresAt, ?string $baseUrl = null): array
    {
        $now = gmdate(DATE_ATOM);

        // Ensure only one pending token per host to avoid accidental host churn on reinstall.
        $delete = $this->database->connection()->prepare('DELETE FROM install_tokens WHERE host_id = :host_id');
        $delete->execute(['host_id' => $hostId]);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO install_tokens (token, host_id, api_key, fqdn, base_url, expires_at, created_at) VALUES (:token, :host_id, :api_key, :fqdn, :base_url, :expires_at, :created_at)'
        );

        $statement->execute([
            'token' => $token,
            'host_id' => $hostId,
            'api_key' => $apiKey,
            'fqdn' => $fqdn,
            'base_url' => $baseUrl,
            'expires_at' => $expiresAt,
            'created_at' => $now,
        ]);

        return $this->findByToken($token);
    }

    public function findByToken(string $token): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT * FROM install_tokens WHERE token = :token LIMIT 1'
        );
        $statement->execute(['token' => $token]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row ?: null;
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
}
