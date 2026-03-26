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

class InsecureAuthRequestRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function findPendingByHost(int $hostId): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, host_id, status, request_ip, requested_at, resolved_at, updated_at
             FROM insecure_auth_requests
             WHERE host_id = :host_id AND status = :status
             ORDER BY id DESC
             LIMIT 1'
        );
        $statement->execute([
            'host_id' => $hostId,
            'status' => 'pending',
        ]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row !== false ? $this->normalizeRow($row) : null;
    }

    public function findLatestByHost(int $hostId): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, host_id, status, request_ip, requested_at, resolved_at, updated_at
             FROM insecure_auth_requests
             WHERE host_id = :host_id
             ORDER BY id DESC
             LIMIT 1'
        );
        $statement->execute(['host_id' => $hostId]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row !== false ? $this->normalizeRow($row) : null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, host_id, status, request_ip, requested_at, resolved_at, updated_at
             FROM insecure_auth_requests
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row !== false ? $this->normalizeRow($row) : null;
    }

    public function listPending(int $limit = 50): array
    {
        $limit = max(1, min($limit, 200));
        $statement = $this->database->connection()->prepare(
            'SELECT r.id, r.host_id, r.status, r.request_ip, r.requested_at, r.resolved_at, r.updated_at, h.fqdn
             FROM insecure_auth_requests r
             LEFT JOIN hosts h ON h.id = r.host_id
             WHERE r.status = :status
             ORDER BY r.id ASC
             LIMIT :limit'
        );
        $statement->bindValue('status', 'pending');
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        if (!is_array($rows)) {
            return [];
        }

        return array_map(fn(array $row): array => $this->normalizeRow($row), $rows);
    }

    public function create(int $hostId, ?string $requestIp = null): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO insecure_auth_requests (host_id, status, request_ip, requested_at, updated_at)
             VALUES (:host_id, :status, :request_ip, :requested_at, :updated_at)'
        );

        $statement->execute([
            'host_id' => $hostId,
            'status' => 'pending',
            'request_ip' => $requestIp,
            'requested_at' => $now,
            'updated_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();

        return [
            'id' => $id,
            'host_id' => $hostId,
            'status' => 'pending',
            'request_ip' => $requestIp,
            'requested_at' => $now,
            'resolved_at' => null,
            'updated_at' => $now,
        ];
    }

    public function markApproved(int $id): void
    {
        $this->markResolved($id, 'approved');
    }

    public function markDenied(int $id): void
    {
        $this->markResolved($id, 'denied');
    }

    private function markResolved(int $id, string $status): void
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'UPDATE insecure_auth_requests
             SET status = :status, resolved_at = :resolved_at, updated_at = :updated_at
             WHERE id = :id'
        );

        $statement->execute([
            'status' => $status,
            'resolved_at' => $now,
            'updated_at' => $now,
            'id' => $id,
        ]);
    }

    private function normalizeRow(array $row): array
    {
        return [
            'id' => isset($row['id']) ? (int) $row['id'] : 0,
            'host_id' => isset($row['host_id']) ? (int) $row['host_id'] : 0,
            'status' => isset($row['status']) ? (string) $row['status'] : '',
            'request_ip' => $row['request_ip'] ?? null,
            'requested_at' => $row['requested_at'] ?? null,
            'resolved_at' => $row['resolved_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
            'fqdn' => isset($row['fqdn']) && is_string($row['fqdn']) ? $row['fqdn'] : null,
        ];
    }
}
