<?php

declare(strict_types=1);

namespace App\Repositories;

use App\Database;
use PDO;

class ProjectEventRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function create(
        int $projectId,
        int $seq,
        string $eventType,
        string $action,
        ?string $entityType,
        null|int|string $entityId,
        ?array $payload,
        ?int $sourceHostId
    ): array {
        $now = gmdate(DATE_ATOM);
        $statement = $this->database->connection()->prepare(
            'INSERT INTO coord_project_events
                (project_id, seq, event_type, action, entity_type, entity_id, payload_json, source_host_id, created_at)
             VALUES
                (:project_id, :seq, :event_type, :action, :entity_type, :entity_id, :payload_json, :source_host_id, :created_at)'
        );
        $statement->execute([
            'project_id' => $projectId,
            'seq' => $seq,
            'event_type' => $eventType,
            'action' => $action,
            'entity_type' => $entityType,
            'entity_id' => $entityId !== null ? (string) $entityId : null,
            'payload_json' => $payload !== null ? json_encode($payload, JSON_UNESCAPED_SLASHES) : null,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
        ]);

        return [
            'seq' => $seq,
            'project_id' => $projectId,
            'event_type' => $eventType,
            'action' => $action,
            'entity_type' => $entityType,
            'entity_id' => $entityId !== null ? (string) $entityId : null,
            'payload' => $payload,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
        ];
    }

    public function listSince(int $projectId, int $since = 0, int $limit = 200): array
    {
        $limit = max(1, min($limit, 500));
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, seq, event_type, action, entity_type, entity_id, payload_json, source_host_id, created_at
             FROM coord_project_events
             WHERE project_id = :project_id
               AND seq > :since
             ORDER BY seq ASC
             LIMIT :limit'
        );
        $statement->bindValue('project_id', $projectId, PDO::PARAM_INT);
        $statement->bindValue('since', $since, PDO::PARAM_INT);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return array_values(array_filter(array_map([$this, 'hydrate'], is_array($rows) ? $rows : [])));
    }

    public function recent(int $projectId, int $limit = 20): array
    {
        $limit = max(1, min($limit, 200));
        $statement = $this->database->connection()->prepare(
            'SELECT id, project_id, seq, event_type, action, entity_type, entity_id, payload_json, source_host_id, created_at
             FROM coord_project_events
             WHERE project_id = :project_id
             ORDER BY seq DESC
             LIMIT :limit'
        );
        $statement->bindValue('project_id', $projectId, PDO::PARAM_INT);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();
        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);
        $events = array_values(array_filter(array_map([$this, 'hydrate'], is_array($rows) ? $rows : [])));

        return array_reverse($events);
    }

    private function hydrate(null|array|false $row): ?array
    {
        if (!is_array($row)) {
            return null;
        }

        $payload = null;
        if (array_key_exists('payload_json', $row) && $row['payload_json'] !== null) {
            $decoded = json_decode((string) $row['payload_json'], true);
            $payload = is_array($decoded) ? $decoded : null;
        }

        return [
            'id' => isset($row['id']) ? (int) $row['id'] : null,
            'project_id' => isset($row['project_id']) ? (int) $row['project_id'] : null,
            'seq' => isset($row['seq']) ? (int) $row['seq'] : 0,
            'event_type' => (string) ($row['event_type'] ?? ''),
            'action' => (string) ($row['action'] ?? ''),
            'entity_type' => $row['entity_type'] ?? null,
            'entity_id' => $row['entity_id'] ?? null,
            'payload' => $payload,
            'source_host_id' => isset($row['source_host_id']) && $row['source_host_id'] !== null ? (int) $row['source_host_id'] : null,
            'created_at' => $row['created_at'] ?? null,
        ];
    }
}
