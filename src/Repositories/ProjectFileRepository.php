<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class ProjectFileRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function allByProjectId(int $projectId): array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, stored_name, description, content, content_sha256, mime_type, source_host_id, created_at, updated_at
             FROM coord_project_files
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
            'SELECT id, project_id, stored_name, description, content, content_sha256, mime_type, source_host_id, created_at, updated_at
             FROM coord_project_files
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

    public function findByStoredName(int $projectId, string $storedName): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, stored_name, description, content, content_sha256, mime_type, source_host_id, created_at, updated_at
             FROM coord_project_files
             WHERE project_id = :project_id AND stored_name = :stored_name
             LIMIT 1'
        );
        $statement->execute([
            'project_id' => $projectId,
            'stored_name' => $storedName,
        ]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return is_array($row) ? $row : null;
    }

    public function upsert(
        int $projectId,
        string $storedName,
        ?string $description,
        string $content,
        string $contentSha256,
        ?string $mimeType,
        ?int $sourceHostId
    ): array {
        $now = gmdate(DATE_ATOM);
        $pdo = $this->database->connection();
        $driver = strtolower((string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME));
        if ($driver === 'mysql') {
            $statement = $pdo->prepare(
                'INSERT INTO coord_project_files
                    (project_id, stored_name, description, content, content_sha256, mime_type, source_host_id, created_at, updated_at)
                 VALUES
                    (:project_id, :stored_name, :description, :content, :content_sha256, :mime_type, :source_host_id, :created_at, :updated_at)
                 ON DUPLICATE KEY UPDATE
                    description = VALUES(description),
                    content = VALUES(content),
                    content_sha256 = VALUES(content_sha256),
                    mime_type = VALUES(mime_type),
                    source_host_id = VALUES(source_host_id),
                    updated_at = VALUES(updated_at)'
            );
            $statement->execute([
                'project_id' => $projectId,
                'stored_name' => $storedName,
                'description' => $description,
                'content' => $content,
                'content_sha256' => $contentSha256,
                'mime_type' => $mimeType,
                'source_host_id' => $sourceHostId,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        } else {
            $existing = $this->findByStoredName($projectId, $storedName);
            if ($existing === null) {
                $statement = $pdo->prepare(
                    'INSERT INTO coord_project_files
                        (project_id, stored_name, description, content, content_sha256, mime_type, source_host_id, created_at, updated_at)
                     VALUES
                        (:project_id, :stored_name, :description, :content, :content_sha256, :mime_type, :source_host_id, :created_at, :updated_at)'
                );
                $statement->execute([
                    'project_id' => $projectId,
                    'stored_name' => $storedName,
                    'description' => $description,
                    'content' => $content,
                    'content_sha256' => $contentSha256,
                    'mime_type' => $mimeType,
                    'source_host_id' => $sourceHostId,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            } else {
                $statement = $pdo->prepare(
                    'UPDATE coord_project_files
                     SET description = :description,
                         content = :content,
                         content_sha256 = :content_sha256,
                         mime_type = :mime_type,
                         source_host_id = :source_host_id,
                         updated_at = :updated_at
                     WHERE project_id = :project_id AND stored_name = :stored_name'
                );
                $statement->execute([
                    'project_id' => $projectId,
                    'stored_name' => $storedName,
                    'description' => $description,
                    'content' => $content,
                    'content_sha256' => $contentSha256,
                    'mime_type' => $mimeType,
                    'source_host_id' => $sourceHostId,
                    'updated_at' => $now,
                ]);
            }
        }

        return $this->findByStoredName($projectId, $storedName) ?? [];
    }

    public function delete(int $projectId, int $id): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM coord_project_files WHERE project_id = :project_id AND id = :id'
        );
        $statement->execute([
            'project_id' => $projectId,
            'id' => $id,
        ]);

        return $statement->rowCount() > 0;
    }
}
