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

class MemoryRepository
{
    public function __construct(private readonly Database $database)
    {
    }

    public function upsert(
        int $hostId,
        string $memoryKey,
        string $content,
        ?array $metadata,
        array $tags
    ): array {
        $now = gmdate(DATE_ATOM);
        $tagsArray = array_values($tags);
        $metadataJson = $metadata !== null ? json_encode($metadata, JSON_UNESCAPED_SLASHES) : null;
        $tagsJson = $tagsArray ? json_encode($tagsArray, JSON_UNESCAPED_SLASHES) : null;
        $tagsText = $tagsArray ? implode(' ', $tagsArray) : null;

        $pdo = $this->database->connection();
        $driver = strtolower((string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME));

        if ($driver === 'mysql') {
            $statement = $pdo->prepare(
                'INSERT INTO mcp_memories (host_id, memory_key, content, metadata, tags, tags_text, created_at, updated_at, deleted_at)
                 VALUES (:host_id, :memory_key, :content, :metadata, :tags, :tags_text, :created_at, :updated_at, NULL)
                 ON DUPLICATE KEY UPDATE
                    content = VALUES(content),
                    metadata = VALUES(metadata),
                    tags = VALUES(tags),
                    tags_text = VALUES(tags_text),
                    updated_at = VALUES(updated_at),
                    deleted_at = NULL'
            );

            $statement->execute([
                'host_id' => $hostId,
                'memory_key' => $memoryKey,
                'content' => $content,
                'metadata' => $metadataJson,
                'tags' => $tagsJson,
                'tags_text' => $tagsText,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        } else {
            $existing = $this->findByKey($hostId, $memoryKey);
            if ($existing === null) {
                $statement = $pdo->prepare(
                    'INSERT INTO mcp_memories (host_id, memory_key, content, metadata, tags, tags_text, created_at, updated_at, deleted_at)
                     VALUES (:host_id, :memory_key, :content, :metadata, :tags, :tags_text, :created_at, :updated_at, NULL)'
                );
                $statement->execute([
                    'host_id' => $hostId,
                    'memory_key' => $memoryKey,
                    'content' => $content,
                    'metadata' => $metadataJson,
                    'tags' => $tagsJson,
                    'tags_text' => $tagsText,
                    'created_at' => $now,
                    'updated_at' => $now,
                ]);
            } else {
                $statement = $pdo->prepare(
                    'UPDATE mcp_memories
                     SET content = :content,
                         metadata = :metadata,
                         tags = :tags,
                         tags_text = :tags_text,
                         updated_at = :updated_at,
                         deleted_at = NULL
                     WHERE host_id = :host_id AND memory_key = :memory_key'
                );
                $statement->execute([
                    'host_id' => $hostId,
                    'memory_key' => $memoryKey,
                    'content' => $content,
                    'metadata' => $metadataJson,
                    'tags' => $tagsJson,
                    'tags_text' => $tagsText,
                    'updated_at' => $now,
                ]);
            }
        }

        return $this->findByKey($hostId, $memoryKey) ?? [];
    }

    public function findByKey(int $hostId, string $memoryKey): ?array
    {
        $statement = $this->database->connection()->prepare(
            'SELECT id, host_id, memory_key, content, metadata, tags, created_at, updated_at
             FROM mcp_memories
             WHERE host_id = :host_id
               AND memory_key = :memory_key
               AND (deleted_at IS NULL)
             LIMIT 1'
        );

        $statement->execute([
            'host_id' => $hostId,
            'memory_key' => $memoryKey,
        ]);

        $row = $statement->fetch(PDO::FETCH_ASSOC);

        return $this->hydrateRow($row);
    }

    public function recent(int $hostId, int $limit): array
    {
        $limit = max(1, min($limit, 500));
        $statement = $this->database->connection()->prepare(
            'SELECT id, host_id, memory_key, content, metadata, tags, created_at, updated_at
             FROM mcp_memories
             WHERE host_id = :host_id
               AND (deleted_at IS NULL)
             ORDER BY updated_at DESC, id DESC
             LIMIT :limit'
        );

        $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return array_values(array_filter(array_map([$this, 'hydrateRow'], $rows)));
    }

    public function search(int $hostId, string $query, int $limit): array
    {
        $limit = max(1, min($limit, 200));
        $pdo = $this->database->connection();
        $driver = strtolower((string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME));

        if ($query !== '' && $driver === 'mysql') {
            $statement = $pdo->prepare(
                'SELECT id, host_id, memory_key, content, metadata, tags, created_at, updated_at,
                        MATCH(content, tags_text) AGAINST (:query IN NATURAL LANGUAGE MODE) AS score
                 FROM mcp_memories
                 WHERE host_id = :host_id
                   AND (deleted_at IS NULL)
                   AND MATCH(content, tags_text) AGAINST (:query IN NATURAL LANGUAGE MODE)
                 ORDER BY score DESC, updated_at DESC
                 LIMIT :limit'
            );
            $statement->bindValue('query', $query);
            $statement->bindValue('host_id', $hostId, PDO::PARAM_INT);
            $statement->bindValue('limit', $limit, PDO::PARAM_INT);
            $statement->execute();
        } else {
            $sql = 'SELECT id, host_id, memory_key, content, metadata, tags, created_at, updated_at
                    FROM mcp_memories
                    WHERE host_id = :host_id
                      AND (deleted_at IS NULL)';
            $params = ['host_id' => $hostId];
            if ($query !== '') {
                $sql .= ' AND (content LIKE :like OR tags_text LIKE :like)';
                $params['like'] = '%' . $query . '%';
            }
            $sql .= ' ORDER BY updated_at DESC, id DESC LIMIT :limit';

            $statement = $pdo->prepare($sql);
            foreach ($params as $key => $value) {
                $statement->bindValue($key, $value, $key === 'host_id' || $key === 'limit' ? PDO::PARAM_INT : PDO::PARAM_STR);
            }
            $statement->bindValue('limit', $limit, PDO::PARAM_INT);
            $statement->execute();
        }

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return array_values(array_filter(array_map([$this, 'hydrateRow'], $rows)));
    }

    public function adminSearch(?int $hostId, string $query, array $tags, int $limit): array
    {
        $pdo = $this->database->connection();
        $driver = strtolower((string) $pdo->getAttribute(PDO::ATTR_DRIVER_NAME));
        $limit = max(1, min($limit, 200));

        $conditions = ['m.deleted_at IS NULL'];
        $params = [];

        if ($hostId !== null) {
            $conditions[] = 'm.host_id = :host_id';
            $params['host_id'] = $hostId;
        }

        if ($query !== '' && $driver !== 'mysql') {
            $conditions[] = '(m.content LIKE :like OR m.tags_text LIKE :like)';
            $params['like'] = '%' . $query . '%';
        }

        foreach ($tags as $idx => $tag) {
            $key = 'tag' . $idx;
            $conditions[] = '(m.tags_text LIKE :' . $key . ')';
            $params[$key] = '%' . $tag . '%';
        }

        $where = 'WHERE ' . implode(' AND ', $conditions);

        if ($query !== '' && $driver === 'mysql') {
            $sql = <<<SQL
                SELECT m.id, m.host_id, h.fqdn AS host_fqdn, m.memory_key, m.content, m.metadata, m.tags, m.created_at, m.updated_at,
                       MATCH(m.content, m.tags_text) AGAINST (:query IN NATURAL LANGUAGE MODE) AS score
                FROM mcp_memories m
                JOIN hosts h ON h.id = m.host_id
                {$where}
                  AND MATCH(m.content, m.tags_text) AGAINST (:query IN NATURAL LANGUAGE MODE)
                ORDER BY score DESC, m.updated_at DESC
                LIMIT :limit
            SQL;
            $statement = $pdo->prepare($sql);
            $statement->bindValue('query', $query);
        } else {
            $sql = <<<SQL
                SELECT m.id, m.host_id, h.fqdn AS host_fqdn, m.memory_key, m.content, m.metadata, m.tags, m.created_at, m.updated_at
                FROM mcp_memories m
                JOIN hosts h ON h.id = m.host_id
                {$where}
                ORDER BY m.updated_at DESC, m.id DESC
                LIMIT :limit
            SQL;
            $statement = $pdo->prepare($sql);
        }

        foreach ($params as $key => $value) {
            $statement->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
        }
        $statement->bindValue('limit', $limit, PDO::PARAM_INT);
        $statement->execute();

        $rows = $statement->fetchAll(PDO::FETCH_ASSOC);

        return array_values(array_filter(array_map([$this, 'hydrateRow'], $rows)));
    }

    public function deleteById(int $id): void
    {
        $statement = $this->database->connection()->prepare(
            'UPDATE mcp_memories SET deleted_at = :deleted_at WHERE id = :id'
        );
        $statement->execute([
            'id' => $id,
            'deleted_at' => gmdate(DATE_ATOM),
        ]);
    }

    private function hydrateRow(null|array|false $row): ?array
    {
        if (!is_array($row)) {
            return null;
        }

        $metadata = null;
        if (isset($row['metadata']) && $row['metadata'] !== null) {
            $decoded = json_decode((string) $row['metadata'], true);
            $metadata = is_array($decoded) ? $decoded : null;
        }

        $tags = [];
        if (isset($row['tags']) && $row['tags'] !== null) {
            $decoded = json_decode((string) $row['tags'], true);
            if (is_array($decoded)) {
                $tags = array_values(array_filter(array_map(static fn ($tag) => is_string($tag) ? $tag : '', $decoded), static fn ($t) => $t !== ''));
            }
        }

        $score = null;
        if (isset($row['score'])) {
            $score = is_numeric($row['score']) ? (float) $row['score'] : null;
        }

        return [
            'id' => isset($row['id']) ? (int) $row['id'] : null,
            'host_id' => isset($row['host_id']) ? (int) $row['host_id'] : null,
            'host_fqdn' => $row['host_fqdn'] ?? null,
            'memory_key' => $row['memory_key'] ?? null,
            'content' => $row['content'] ?? '',
            'metadata' => $metadata,
            'tags' => $tags,
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
            'score' => $score,
        ];
    }
}
