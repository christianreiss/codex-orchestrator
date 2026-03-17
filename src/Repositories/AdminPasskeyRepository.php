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

class AdminPasskeyRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function create(
        int $userId,
        string $credentialId,
        string $credentialIdHash,
        string $publicKeyPem,
        int $coseAlg,
        int $signCount,
        string $name,
        ?string $transports,
        ?string $aaguid
    ): array {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO admin_passkeys (user_id, credential_id, credential_id_hash, public_key_pem, cose_alg, sign_count, name, transports, aaguid, created_at)
             VALUES (:user_id, :credential_id, :credential_id_hash, :public_key_pem, :cose_alg, :sign_count, :name, :transports, :aaguid, :created_at)'
        );

        $statement->execute([
            'user_id' => $userId,
            'credential_id' => $credentialId,
            'credential_id_hash' => $credentialIdHash,
            'public_key_pem' => $publicKeyPem,
            'cose_alg' => $coseAlg,
            'sign_count' => $signCount,
            'name' => $name,
            'transports' => $transports,
            'aaguid' => $aaguid,
            'created_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        return $this->findById($id) ?? [];
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, credential_id, credential_id_hash, public_key_pem, cose_alg, sign_count, name, transports, aaguid, created_at, last_used_at
             FROM admin_passkeys WHERE id = :id LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findByCredentialIdHash(string $credentialIdHash): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, credential_id, credential_id_hash, public_key_pem, cose_alg, sign_count, name, transports, aaguid, created_at, last_used_at
             FROM admin_passkeys WHERE credential_id_hash = :hash LIMIT 1'
        );
        $statement->execute(['hash' => $credentialIdHash]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function findAllForUser(int $userId): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, user_id, credential_id, credential_id_hash, public_key_pem, cose_alg, sign_count, name, transports, aaguid, created_at, last_used_at
             FROM admin_passkeys WHERE user_id = :user_id ORDER BY created_at ASC'
        );
        $statement->execute(['user_id' => $userId]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        return is_array($rows) ? $rows : [];
    }

    public function updateSignCount(int $id, int $signCount, string $lastUsedAt): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_passkeys SET sign_count = :sign_count, last_used_at = :last_used_at WHERE id = :id'
        );
        $statement->execute([
            'sign_count' => $signCount,
            'last_used_at' => $lastUsedAt,
            'id' => $id,
        ]);
    }

    public function updateName(int $id, string $name): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE admin_passkeys SET name = :name WHERE id = :id'
        );
        $statement->execute([
            'name' => $name,
            'id' => $id,
        ]);
    }

    public function delete(int $id): void
    {
        $statement = $this->database->connection()->prepare('DELETE FROM admin_passkeys WHERE id = :id');
        $statement->execute(['id' => $id]);
    }

    public function deleteAllForUser(int $userId): void
    {
        $statement = $this->database->connection()->prepare('DELETE FROM admin_passkeys WHERE user_id = :user_id');
        $statement->execute(['user_id' => $userId]);
    }

    public function countForUser(int $userId): int
    {
        $statement = $this->database->connection()->prepare(
            'SELECT COUNT(*) AS total FROM admin_passkeys WHERE user_id = :user_id'
        );
        $statement->execute(['user_id' => $userId]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return (int) ($row['total'] ?? 0);
    }

    public function countAll(): int
    {
        $statement = $this->database->connection()->query('SELECT COUNT(*) AS total FROM admin_passkeys');
        $row = $statement->fetch(PDO::FETCH_ASSOC);
        return (int) ($row['total'] ?? 0);
    }
}
