<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class ProjectNoteRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function allByProjectId(int $projectId): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, header, body, source_host_id, created_at, updated_at
             FROM coord_project_notes
             WHERE project_id = :project_id
             ORDER BY updated_at DESC, id DESC'
        );
        $statement->execute(['project_id' => $projectId]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function find(int $projectId, int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, header, body, source_host_id, created_at, updated_at
             FROM coord_project_notes
             WHERE project_id = :project_id AND id = :id
             LIMIT 1'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
        ]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function create(int $projectId, string $header, string $body, ?int $sourceHostId): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO coord_project_notes (project_id, header, body, source_host_id, created_at, updated_at)
             VALUES (:project_id, :header, :body, :source_host_id, :created_at, :updated_at)'
        );
        $statement->execute([
            'project_id' => $projectId,
            'header' => $header,
            'body' => $body,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->find($projectId, (int) $this->database->connection()->lastInsertId()) ?? [];
    }

    public function update(int $projectId, int $id, string $header, string $body, ?int $sourceHostId): array
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE coord_project_notes
             SET header = :header, body = :body, source_host_id = :source_host_id, updated_at = :updated_at
             WHERE project_id = :project_id AND id = :id'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
            'header' => $header,
            'body' => $body,
            'source_host_id' => $sourceHostId,
            'updated_at' => gmdate(DATE_ATOM),
        ]);

        return $this->find($projectId, $id) ?? [];
    }

    public function delete(int $projectId, int $id): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM coord_project_notes WHERE project_id = :project_id AND id = :id'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
        ]);

        return $statement->rowCount() > 0;
    }
}
