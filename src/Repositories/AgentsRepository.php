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

class AgentsRepository
{
    public const STATE_ID = 1;
    public const MODE_LATEST = 'latest';
    public const MODE_LOCKED = 'locked';

    public function __construct(private readonly Database $database)
    {
    }

    public function latest(): ?array
    {
        $statement = $this->database->connection()->query(
            'SELECT id, sha256, body, source_host_id, created_at, updated_at
             FROM agents_documents
             ORDER BY id DESC
             LIMIT 1'
        );

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, sha256, body, source_host_id, created_at, updated_at
             FROM agents_documents
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => $id]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function listVersions(int $limit = 50): array
    {
        $limit = max(1, min($limit, 200));
        $statement = $this->database->connection()->prepare(
            'SELECT id, sha256, body, source_host_id, created_at, updated_at
             FROM agents_documents
             ORDER BY id DESC
             LIMIT :limit'
        );
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function createVersion(string $body, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $now = gmdate(DATE_ATOM);
        $sha = $sha256 ?? hash('sha256', $body);

        $statement = $this->database->connection()->prepare(
            'INSERT INTO agents_documents (sha256, body, source_host_id, created_at, updated_at)
             VALUES (:sha256, :body, :source_host_id, :created_at, :updated_at)'
        );

        $statement->execute([
            'sha256' => $sha,
            'body' => $body,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $id = (int) $this->database->connection()->lastInsertId();
        return $this->findById($id) ?? [];
    }

    public function deleteVersion(int $id): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM agents_documents WHERE id = :id'
        );
        $statement->execute(['id' => $id]);

        return $statement->rowCount() > 0;
    }

    public function state(): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, mode, active_document_id, created_at, updated_at
             FROM agents_document_state
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => self::STATE_ID]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        if (is_array($row)) {
            return $row;
        }

        $now = gmdate(DATE_ATOM);
        $insert = $this->database->connection()->prepare(
            'INSERT INTO agents_document_state (id, mode, active_document_id, created_at, updated_at)
             VALUES (:id, :mode, :active_document_id, :created_at, :updated_at)'
        );
        $insert->execute([
            'id' => self::STATE_ID,
            'mode' => self::MODE_LATEST,
            'active_document_id' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return [
            'id' => self::STATE_ID,
            'mode' => self::MODE_LATEST,
            'active_document_id' => null,
            'created_at' => $now,
            'updated_at' => $now,
        ];
    }

    public function updateState(string $mode, ?int $activeId): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'UPDATE agents_document_state
             SET mode = :mode, active_document_id = :active_document_id, updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'mode' => $mode,
            'active_document_id' => $activeId,
            'updated_at' => $now,
            'id' => self::STATE_ID,
        ]);

        return $this->state();
    }
}
