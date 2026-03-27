<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use App\Security\SecretBox;
use PDO;

class CliAuthRequestRepository
{
    public function __construct(
        private readonly Database $database,
        private readonly SecretBox $encrypter
    ) {
    }

    public function create(
        string $requestId,
        string $userCode,
        string $fqdn,
        bool $secure,
        string $expiresAt,
        ?string $ip,
        ?string $userAgent
    ): array {
        $now = gmdate(DATE_ATOM);
        $requestIdHash = hash('sha256', $requestId);
        $requestIdEnc = $this->encrypter->encrypt($requestId);
        $userCodeHash = hash('sha256', $userCode);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO cli_auth_requests
                (request_id, request_id_enc, user_code, user_code_hash, fqdn, secure, status, ip, user_agent, expires_at, created_at)
             VALUES
                (:request_id, :request_id_enc, :user_code, :user_code_hash, :fqdn, :secure, :status, :ip, :user_agent, :expires_at, :created_at)'
        );

        $statement->execute([
            'request_id' => $requestIdHash,
            'request_id_enc' => $requestIdEnc,
            'user_code' => $userCode,
            'user_code_hash' => $userCodeHash,
            'fqdn' => $fqdn,
            'secure' => $secure ? 1 : 0,
            'status' => 'pending',
            'ip' => $ip,
            'user_agent' => $userAgent !== null ? substr($userAgent, 0, 255) : null,
            'expires_at' => $expiresAt,
            'created_at' => $now,
        ]);

        return $this->findByRequestId($requestId) ?? [];
    }

    public function findByRequestId(string $requestId): ?array
    {
        $hash = hash('sha256', $requestId);

        $statement = $this->database->connection()->prepare(
            'SELECT * FROM cli_auth_requests WHERE request_id = :hash LIMIT 1'
        );
        $statement->execute(['hash' => $hash]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return $this->hydrateRow($row, $requestId);
    }

    public function findByUserCode(string $userCode): ?array
    {
        $hash = hash('sha256', $userCode);

        $statement = $this->database->connection()->prepare(
            "SELECT * FROM cli_auth_requests WHERE user_code_hash = :hash AND status = 'pending' LIMIT 1"
        );
        $statement->execute(['hash' => $hash]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            return null;
        }

        return $this->hydrateRow($row);
    }

    public function approve(int $id, int $userId, int $hostId, string $apiKey): void
    {
        $apiKeyEnc = $this->encrypter->encrypt($apiKey);

        $statement = $this->database->connection()->prepare(
            "UPDATE cli_auth_requests
             SET status = 'approved', approved_by_user_id = :user_id, host_id = :host_id,
                 api_key_enc = :api_key_enc, approved_at = :approved_at
             WHERE id = :id"
        );
        $statement->execute([
            'user_id' => $userId,
            'host_id' => $hostId,
            'api_key_enc' => $apiKeyEnc,
            'approved_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function deny(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            "UPDATE cli_auth_requests SET status = 'denied' WHERE id = :id"
        );
        $statement->execute(['id' => $id]);
    }

    public function markConsumed(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE cli_auth_requests SET consumed_at = :consumed_at WHERE id = :id'
        );
        $statement->execute([
            'consumed_at' => gmdate(DATE_ATOM),
            'id' => $id,
        ]);
    }

    public function deleteExpired(string $cutoff): void
    {
        $statement = $this->database->connection()->prepare(
            "DELETE FROM cli_auth_requests WHERE expires_at < :cutoff OR (status = 'approved' AND consumed_at IS NOT NULL)"
        );
        $statement->execute(['cutoff' => $cutoff]);
    }

    public function countPendingByIp(string $ip, string $since): int
    {
        $statement = $this->database->connection()->prepare(
            "SELECT COUNT(*) FROM cli_auth_requests WHERE ip = :ip AND status = 'pending' AND created_at >= :since"
        );
        $statement->execute(['ip' => $ip, 'since' => $since]);

        return (int) $statement->fetchColumn();
    }

    private function hydrateRow(array $row, ?string $knownRequestId = null): array
    {
        if ($knownRequestId !== null) {
            $row['request_id_plain'] = $knownRequestId;
        } else {
            $row['request_id_plain'] = $this->decryptValue($row['request_id_enc'] ?? null);
        }

        $row['api_key_plain'] = $this->decryptValue($row['api_key_enc'] ?? null);

        return $row;
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
