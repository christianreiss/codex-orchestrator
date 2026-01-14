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

class InsecureDomainAllowRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, domain, window_minutes, enabled_until, revoked_at, created_at, updated_at
             FROM insecure_domain_allows
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row !== false ? $this->normalizeRow($row) : null;
    }

    public function findByDomain(string $domain): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, domain, window_minutes, enabled_until, revoked_at, created_at, updated_at
             FROM insecure_domain_allows
             WHERE domain = :domain
             LIMIT 1'
        );
        $statement->execute(['domain' => $domain]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $row !== false ? $this->normalizeRow($row) : null;
    }

    public function listActiveCandidates(): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, domain, window_minutes, enabled_until, revoked_at, created_at, updated_at
             FROM insecure_domain_allows
             WHERE revoked_at IS NULL
             ORDER BY LENGTH(domain) DESC, domain ASC'
        );
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        return array_map([$this, 'normalizeRow'], $rows);
    }

    public function listAll(): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, domain, window_minutes, enabled_until, revoked_at, created_at, updated_at
             FROM insecure_domain_allows
             ORDER BY domain ASC'
        );
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC) ?: [];

        return array_map([$this, 'normalizeRow'], $rows);
    }

    public function upsert(string $domain, int $windowMinutes, string $enabledUntil): array
    {
        $existing = $this->findByDomain($domain);
        $now = gmdate(DATE_ATOM);

        if ($existing !== null) {
            $statement = $this->database->connection()->prepare(
                'UPDATE insecure_domain_allows
                 SET window_minutes = :window_minutes,
                     enabled_until = :enabled_until,
                     revoked_at = NULL,
                     updated_at = :updated_at
                 WHERE id = :id'
            );
            $statement->execute([
                'window_minutes' => $windowMinutes,
                'enabled_until' => $enabledUntil,
                'updated_at' => $now,
                'id' => $existing['id'],
            ]);

            return [
                'id' => (int) $existing['id'],
                'domain' => $domain,
                'window_minutes' => $windowMinutes,
                'enabled_until' => $enabledUntil,
                'revoked_at' => null,
                'created_at' => $existing['created_at'] ?? $now,
                'updated_at' => $now,
            ];
        }

        $statement = $this->database->connection()->prepare(
            'INSERT INTO insecure_domain_allows (domain, window_minutes, enabled_until, created_at, updated_at)
             VALUES (:domain, :window_minutes, :enabled_until, :created_at, :updated_at)'
        );
        $statement->execute([
            'domain' => $domain,
            'window_minutes' => $windowMinutes,
            'enabled_until' => $enabledUntil,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();

        return [
            'id' => $id,
            'domain' => $domain,
            'window_minutes' => $windowMinutes,
            'enabled_until' => $enabledUntil,
            'revoked_at' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ];
    }

    public function touchWindow(int $id, string $enabledUntil): void
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'UPDATE insecure_domain_allows
             SET enabled_until = :enabled_until,
                 updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'enabled_until' => $enabledUntil,
            'updated_at' => $now,
            'id' => $id,
        ]);
    }

    public function markRevoked(int $id): void
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'UPDATE insecure_domain_allows
             SET revoked_at = :revoked_at,
                 updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'revoked_at' => $now,
            'updated_at' => $now,
            'id' => $id,
        ]);
    }

    private function normalizeRow(array $row): array
    {
        return [
            'id' => isset($row['id']) ? (int) $row['id'] : 0,
            'domain' => isset($row['domain']) ? (string) $row['domain'] : '',
            'window_minutes' => isset($row['window_minutes']) ? (int) $row['window_minutes'] : null,
            'enabled_until' => $row['enabled_until'] ?? null,
            'revoked_at' => $row['revoked_at'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
        ];
    }
}
