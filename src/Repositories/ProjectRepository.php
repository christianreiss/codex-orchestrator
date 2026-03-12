<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;
use RuntimeException;

class ProjectRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function all(bool $includeArchived = false): array
    {
        $sql = 'SELECT id, slug, about_json, roster_markdown, latest_event_seq, created_at, updated_at, archived_at
                FROM coord_projects';
        if (!$includeArchived) {
            $sql .= ' WHERE archived_at IS NULL';
        }
        $sql .= ' ORDER BY updated_at DESC, slug ASC';

        $statement = $this->database->connection()->query($sql);
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return array_values(array_filter(array_map([$this, 'hydrate'], is_array($rows) ? $rows : [])));
    }

    public function findBySlug(string $slug, bool $includeArchived = false): ?array
    {
        $sql = 'SELECT id, slug, about_json, roster_markdown, latest_event_seq, created_at, updated_at, archived_at
                FROM coord_projects
                WHERE slug = :slug';
        if (!$includeArchived) {
            $sql .= ' AND archived_at IS NULL';
        }
        $sql .= ' LIMIT 1';

        $statement = $this->database->connection()->prepare($sql);
        $statement->execute(['slug' => $slug]);

        return $this->hydrate($statement->fetch(PDO::FETCH_ASSOC));
    }

    public function findById(int $id): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, slug, about_json, roster_markdown, latest_event_seq, created_at, updated_at, archived_at
             FROM coord_projects
             WHERE id = :id
             LIMIT 1'
        );
        $statement->execute(['id' => $id]);

        return $this->hydrate($statement->fetch(PDO::FETCH_ASSOC));
    }

    public function create(string $slug, ?array $about, ?string $rosterMarkdown): array
    {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO coord_projects (slug, about_json, roster_markdown, latest_event_seq, created_at, updated_at, archived_at)
             VALUES (:slug, :about_json, :roster_markdown, 0, :created_at, :updated_at, NULL)'
        );
        $statement->execute([
            'slug' => $slug,
            'about_json' => $about !== null ? json_encode($about, JSON_UNESCAPED_SLASHES) : null,
            'roster_markdown' => $rosterMarkdown,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        return $this->findBySlug($slug, true) ?? [];
    }

    public function updateAbout(int $projectId, ?array $about): array
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE coord_projects
             SET about_json = :about_json, updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'id' => $projectId,
            'about_json' => $about !== null ? json_encode($about, JSON_UNESCAPED_SLASHES) : null,
            'updated_at' => gmdate(DATE_ATOM),
        ]);

        return $this->findById($projectId) ?? [];
    }

    public function updateRoster(int $projectId, string $rosterMarkdown): array
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE coord_projects
             SET roster_markdown = :roster_markdown, updated_at = :updated_at
             WHERE id = :id'
        );
        $statement->execute([
            'id' => $projectId,
            'roster_markdown' => $rosterMarkdown,
            'updated_at' => gmdate(DATE_ATOM),
        ]);

        return $this->findById($projectId) ?? [];
    }

    public function archive(int $projectId): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE coord_projects
             SET archived_at = :archived_at, updated_at = :updated_at
             WHERE id = :id'
        );
        $now = gmdate(DATE_ATOM);
        $statement->execute([
            'id' => $projectId,
            'archived_at' => $now,
            'updated_at' => $now,
        ]);
    }

    public function delete(int $projectId): bool
    {
        $statement = $this->database->connection()->prepare(
            'DELETE FROM coord_projects WHERE id = :id'
        );
        $statement->execute(['id' => $projectId]);

        return $statement->rowCount() > 0;
    }

    public function nextEventSeq(int $projectId): int
    {
        $pdo = $this->database->connection();
        $driver = strtolower((string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME));
        $now = gmdate(DATE_ATOM);

        if ($driver === 'mysql') {
            $statement = $pdo->prepare(
                'UPDATE coord_projects
                 SET latest_event_seq = LAST_INSERT_ID(latest_event_seq + 1),
                     updated_at = :updated_at
                 WHERE id = :id'
            );
            $statement->execute([
                'id' => $projectId,
                'updated_at' => $now,
            ]);

            if ($statement->rowCount() < 1) {
                throw new RuntimeException('Project not found for event allocation');
            }

            return (int) $pdo->lastInsertId();
        }

        $pdo->beginTransaction();
        try {
            $select = $pdo->prepare('SELECT latest_event_seq FROM coord_projects WHERE id = :id LIMIT 1');
            $select->execute(['id' => $projectId]);
            $current = $select->fetchColumn();
            if ($current === false) {
                throw new RuntimeException('Project not found for event allocation');
            }

            $next = (int) $current + 1;
            $update = $pdo->prepare(
                'UPDATE coord_projects
                 SET latest_event_seq = :seq, updated_at = :updated_at
                 WHERE id = :id'
            );
            $update->execute([
                'id' => $projectId,
                'seq' => $next,
                'updated_at' => $now,
            ]);
            $pdo->commit();

            return $next;
        } catch (\Throwable $exception) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $exception;
        }
    }

    private function hydrate(null|array|false $row): ?array
    {
        if (!is_array($row)) {
            return null;
        }

        $about = null;
        if (array_key_exists('about_json', $row) && $row['about_json'] !== null) {
            $decoded = json_decode((string) $row['about_json'], true);
            $about = is_array($decoded) ? $decoded : null;
        }

        return [
            'id' => isset($row['id']) ? (int) $row['id'] : null,
            'slug' => (string) ($row['slug'] ?? ''),
            'about' => $about,
            'roster_markdown' => (string) ($row['roster_markdown'] ?? ''),
            'latest_event_seq' => isset($row['latest_event_seq']) ? (int) $row['latest_event_seq'] : 0,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
            'archived_at' => $row['archived_at'] ?? null,
        ];
    }
}
