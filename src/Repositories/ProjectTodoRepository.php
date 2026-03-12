<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class ProjectTodoRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function allByProjectId(int $projectId): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, title, detail, done, source_host_id, created_at, updated_at, done_at
             FROM coord_project_todos
             WHERE project_id = :project_id
             ORDER BY done ASC, updated_at DESC, id DESC'
        );
        $statement->execute(['project_id' => $projectId]);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function find(int $projectId, int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, title, detail, done, source_host_id, created_at, updated_at, done_at
             FROM coord_project_todos
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

    public function create(int $projectId, string $title, string $detail, ?int $sourceHostId): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO coord_project_todos (project_id, title, detail, done, source_host_id, created_at, updated_at, done_at)
             VALUES (:project_id, :title, :detail, 0, :source_host_id, :created_at, :updated_at, NULL)'
        );
        $statement->execute([
            'project_id' => $projectId,
            'title' => $title,
            'detail' => $detail,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->find($projectId, (int) $this->database->connection()->lastInsertId()) ?? [];
    }

    public function update(int $projectId, int $id, string $title, string $detail, ?int $sourceHostId): array
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE coord_project_todos
             SET title = :title, detail = :detail, source_host_id = :source_host_id, updated_at = :updated_at
             WHERE project_id = :project_id AND id = :id'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
            'title' => $title,
            'detail' => $detail,
            'source_host_id' => $sourceHostId,
            'updated_at' => gmdate(DATE_ATOM),
        ]);

        return $this->find($projectId, $id) ?? [];
    }

    public function setDone(int $projectId, int $id, bool $done, ?int $sourceHostId): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'UPDATE coord_project_todos
             SET done = :done,
                 done_at = :done_at,
                 source_host_id = :source_host_id,
                 updated_at = :updated_at
             WHERE project_id = :project_id AND id = :id'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
            'done' => $done ? 1 : 0,
            'done_at' => $done ? $now : null,
            'source_host_id' => $sourceHostId,
            'updated_at' => $now,
        ]);

        return $this->find($projectId, $id) ?? [];
    }

    public function delete(int $projectId, int $id): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM coord_project_todos WHERE project_id = :project_id AND id = :id'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
        ]);

        return $statement->rowCount() > 0;
    }
}
