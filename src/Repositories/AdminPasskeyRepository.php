<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use DateTimeImmutable;
use PDO;

class AdminPasskeyRepository
{
    public function __construct(private Database $db)
    {
    }

    public function findOne(): ?array
    {
        $stmt = $this->db->connection()->query('SELECT * FROM admin_passkeys LIMIT 1');
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function deleteAll(): void
    {
        $this->db->connection()->exec('DELETE FROM admin_passkeys');
    }

    public function saveSingle(string $credentialId, string $publicKey, string $userHandle, int $counter = 0): void
    {
        // Enforce one row: clear and insert.
        $this->deleteAll();
        $now = (new DateTimeImmutable())->format(DATE_ATOM);
        $stmt = $this->db->connection()->prepare(
            'INSERT INTO admin_passkeys (credential_id, public_key, user_handle, counter, created_at, updated_at)
             VALUES (:cid, :pk, :uh, :ctr, :created, :updated)'
        );
        $stmt->execute([
            'cid' => $credentialId,
            'pk' => $publicKey,
            'uh' => $userHandle,
            'ctr' => $counter,
            'created' => $now,
            'updated' => $now,
        ]);
    }

    public function updateCounter(string $credentialId, int $counter): void
    {
        $stmt = $this->db->connection()->prepare(
            'UPDATE admin_passkeys SET counter = :ctr, updated_at = :updated WHERE credential_id = :cid'
        );
        $stmt->execute([
            'cid' => $credentialId,
            'ctr' => $counter,
            'updated' => (new DateTimeImmutable())->format(DATE_ATOM),
        ]);
    }
}
