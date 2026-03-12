<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class ProjectFeedbackRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function all(?int $projectId = null): array
    {
        $sql = 'SELECT id, project_id, type, title, body, status, source_host_id, created_at, updated_at
                FROM coord_project_feedback';
        $params = [];
        if ($projectId !== null) {
            $sql .= ' WHERE project_id = :project_id';
            $params['project_id'] = $projectId;
        }
        $sql .= ' ORDER BY updated_at DESC, id DESC';

        $statement = $this->database->connection()->prepare($sql);
        foreach ($params as $key => $value) {
            $statement->bindValue($key, $value, PDO::PARAM_INT);
        }
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return is_array($rows) ? $rows : [];
    }

    public function create(int $projectId, string $type, string $title, string $body, ?int $sourceHostId): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO coord_project_feedback
                (project_id, type, title, body, status, source_host_id, created_at, updated_at)
             VALUES
                (:project_id, :type, :title, :body, :status, :source_host_id, :created_at, :updated_at)'
        );
        $statement->execute([
            'project_id' => $projectId,
            'type' => $type,
            'title' => $title,
            'body' => $body,
            'status' => 'open',
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, type, title, body, status, source_host_id, created_at, updated_at
             FROM coord_project_feedback
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => (int) $this->database->connection()->lastInsertId()]);
        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : [];
    }
}
