<?php

/*
 * Creator: Christian Reiss
 * Contact: email@christian-reiss.de
 * Mastodon: @chris@social.uggs.io
 * GitHub: https://github.com/christianreiss/codex-orchestrator
 */

namespace App\Services;

use App\Exceptions\ValidationException;
use App\Repositories\LogRepository;
use App\Repositories\MemoryRepository;

class MemoryService
{
    private const MAX_CONTENT_LENGTH = 32000;
    private const MAX_TAGS = 32;
    private const MAX_TAG_LENGTH = 64;

    public function __construct(
        private readonly MemoryRepository $memories,
        private readonly LogRepository $logs
    ) {
    }

    public function store(array $payload, array $host): array
    {
        $errors = [];

        $memoryKey = $this->normalizeKey($payload['id'] ?? ($payload['memory_id'] ?? ($payload['key'] ?? null)), true, $errors);
        $contentRaw = is_array($payload) ? ($payload['content'] ?? ($payload['text'] ?? '')) : '';
        $content = trim((string) $contentRaw);
        if ($content === '') {
            $errors['content'][] = 'content is required';
        }
        if (strlen($content) > self::MAX_CONTENT_LENGTH) {
            $errors['content'][] = sprintf('content must be %d characters or fewer', self::MAX_CONTENT_LENGTH);
        }

        $metadata = $this->normalizeMetadata($payload['metadata'] ?? null, $errors);
        $tags = $this->normalizeTags($payload['tags'] ?? null, $errors);

        if ($errors) {
            throw new ValidationException($errors);
        }

        $memoryKey = $memoryKey ?? $this->generateKey();
        $hostId = $this->hostId($host);
        $existing = $this->memories->findByKey($hostId ?? 0, $memoryKey);
        $saved = $this->memories->upsert($hostId ?? 0, $memoryKey, $content, $metadata, $tags);

        $status = 'created';
        if ($existing !== null) {
            $unchanged = $existing['content'] === $content
                && $this->normalizedArray($existing['tags'] ?? []) === $this->normalizedArray($tags)
                && $this->normalizedAssoc($existing['metadata'] ?? null) === $this->normalizedAssoc($metadata);
            $status = $unchanged ? 'unchanged' : 'updated';
        }

        $this->logs->log($hostId, 'memory.store', [
            'id' => $memoryKey,
            'status' => $status,
            'content_length' => strlen($content),
            'tags' => count($tags),
        ]);

        return [
            'status' => $status,
            'id' => $memoryKey,
            'memory' => $this->formatMemory($saved),
        ];
    }

    public function retrieve(array $payload, array $host): array
    {
        $errors = [];
        $memoryKey = $this->normalizeKey($payload['id'] ?? ($payload['memory_id'] ?? ($payload['key'] ?? null)), false, $errors);
        if ($errors) {
            throw new ValidationException($errors);
        }

        $hostId = $this->hostId($host);
        $memory = $memoryKey !== null ? $this->memories->findByKey($hostId ?? 0, $memoryKey) : null;

        $status = $memory === null ? 'missing' : 'found';

        $this->logs->log($hostId, 'memory.retrieve', [
            'id' => $memoryKey,
            'status' => $status,
        ]);

        return [
            'status' => $status,
            'id' => $memoryKey,
            'memory' => $memory ? $this->formatMemory($memory) : null,
        ];
    }

    public function search(array $payload, array $host): array
    {
        $errors = [];
        $queryRaw = is_array($payload) ? ($payload['query'] ?? ($payload['q'] ?? '')) : '';
        $query = trim((string) $queryRaw);
        $limitRaw = is_array($payload) ? ($payload['limit'] ?? null) : null;
        $limit = is_numeric($limitRaw) ? (int) $limitRaw : 20;
        if ($limit < 1) {
            $limit = 1;
        }
        if ($limit > 100) {
            $limit = 100;
        }

        $tags = $this->normalizeTags($payload['tags'] ?? null, $errors);
        $searchTags = $this->normalizedArray($tags);
        if ($errors) {
            throw new ValidationException($errors);
        }

        $hostId = $this->hostId($host);
        $searchLimit = $limit * max(1, min(3, count($searchTags) > 0 ? 3 : 1));
        $rawResults = $query === ''
            ? $this->memories->recent($hostId ?? 0, $searchLimit)
            : $this->memories->search($hostId ?? 0, $query, $searchLimit);

        $filtered = [];
        foreach ($rawResults as $row) {
            $rowTags = $this->normalizedArray($row['tags'] ?? []);
            $containsAllTags = $searchTags === [] || !array_diff($searchTags, $rowTags);
            if (!$containsAllTags) {
                continue;
            }
            $filtered[] = $this->formatMemory($row, $row['score'] ?? null);
            if (count($filtered) >= $limit) {
                break;
            }
        }

        $this->logs->log($hostId, 'memory.search', [
            'query_length' => strlen($query),
            'limit' => $limit,
            'returned' => count($filtered),
            'tags' => count($tags),
        ]);

        return [
            'status' => 'ok',
            'query' => $query,
            'limit' => $limit,
            'count' => count($filtered),
            'matches' => $filtered,
        ];
    }

    public function adminSearch(array $payload): array
    {
        $errors = [];
        $queryRaw = is_array($payload) ? ($payload['query'] ?? ($payload['q'] ?? '')) : '';
        $query = trim((string) $queryRaw);
        $limitRaw = is_array($payload) ? ($payload['limit'] ?? null) : null;
        $limit = is_numeric($limitRaw) ? (int) $limitRaw : 50;
        if ($limit < 1) {
            $limit = 1;
        }
        if ($limit > 200) {
            $limit = 200;
        }

        $hostId = null;
        if (is_array($payload) && array_key_exists('host_id', $payload) && $payload['host_id'] !== '' && $payload['host_id'] !== null) {
            if (is_numeric($payload['host_id'])) {
                $hostId = (int) $payload['host_id'];
            } else {
                $errors['host_id'][] = 'host_id must be numeric';
            }
        }

        $tags = $this->normalizeTags($payload['tags'] ?? null, $errors);
        $searchTags = $this->normalizedArray($tags);
        if ($errors) {
            throw new ValidationException($errors);
        }

        $results = $this->memories->adminSearch($hostId, $query, $searchTags, $limit);
        $matches = array_map(fn ($row) => $this->formatMemory($row, $row['score'] ?? null), $results);

        $this->logs->log(null, 'memory.admin.search', [
            'query_length' => strlen($query),
            'limit' => $limit,
            'returned' => count($matches),
            'tags' => count($searchTags),
            'host_id' => $hostId,
        ]);

        return [
            'status' => 'ok',
            'query' => $query,
            'host_id' => $hostId,
            'limit' => $limit,
            'count' => count($matches),
            'matches' => $matches,
        ];
    }

    public function adminDelete(int $id): array
    {
        $this->memories->deleteById($id);
        $this->logs->log(null, 'memory.admin.delete', ['id' => $id]);

        return ['deleted' => $id];
    }

    private function normalizeKey(mixed $value, bool $allowNull, array &$errors): ?string
    {
        if ($value === null) {
            if ($allowNull) {
                return null;
            }
            $errors['id'][] = 'id is required';
            return null;
        }

        if (!is_string($value)) {
            $errors['id'][] = 'id must be a string';
            return null;
        }

        $normalized = trim($value);
        if ($normalized === '') {
            if ($allowNull) {
                return null;
            }
            $errors['id'][] = 'id is required';
            return null;
        }

        if (strlen($normalized) > 128) {
            $errors['id'][] = 'id must be 128 characters or fewer';
        }

        if (!preg_match('/^[A-Za-z0-9._:-]+$/', $normalized)) {
            $errors['id'][] = 'id may only contain letters, numbers, dots, underscores, hyphens, and colons';
        }

        return $normalized;
    }

    private function normalizeMetadata(mixed $value, array &$errors): ?array
    {
        if ($value === null) {
            return null;
        }

        if (!is_array($value)) {
            $errors['metadata'][] = 'metadata must be an object';
            return null;
        }

        if (array_is_list($value)) {
            $errors['metadata'][] = 'metadata must use string keys';
            return null;
        }

        return $value;
    }

    private function normalizeTags(mixed $value, array &$errors): array
    {
        if ($value === null) {
            return [];
        }

        if (!is_array($value)) {
            $errors['tags'][] = 'tags must be an array of strings';
            return [];
        }

        $normalized = [];
        $seen = [];
        foreach ($value as $tag) {
            if (!is_string($tag)) {
                $errors['tags'][] = 'tags must be strings';
                continue;
            }
            $trimmed = trim($tag);
            if ($trimmed === '') {
                continue;
            }
            if (strlen($trimmed) > self::MAX_TAG_LENGTH) {
                $errors['tags'][] = sprintf('tag "%s" is longer than %d characters', $trimmed, self::MAX_TAG_LENGTH);
                continue;
            }
            $key = strtolower($trimmed);
            if (isset($seen[$key])) {
                continue;
            }
            $seen[$key] = true;
            $normalized[] = $trimmed;
        }

        $normalized = array_values($normalized);
        if (count($normalized) > self::MAX_TAGS) {
            $errors['tags'][] = sprintf('no more than %d tags allowed', self::MAX_TAGS);
        }

        return $normalized;
    }

    private function normalizedArray(array $value): array
    {
        $normalized = array_values(array_map(
            static fn ($item) => strtolower(is_string($item) ? $item : (string) $item),
            $value
        ));
        $normalized = array_values(array_unique($normalized));
        sort($normalized);

        return $normalized;
    }

    private function normalizedAssoc(?array $value): ?array
    {
        if ($value === null) {
            return null;
        }

        ksort($value);

        return $value;
    }

    private function formatMemory(array $row, ?float $score = null): array
    {
        return [
            'id' => $row['memory_key'] ?? null,
            'host_id' => $row['host_id'] ?? null,
            'host' => $row['host_fqdn'] ?? null,
            'content' => $row['content'] ?? '',
            'metadata' => $row['metadata'] ?? null,
            'tags' => $row['tags'] ?? [],
            'created_at' => $row['created_at'] ?? null,
            'updated_at' => $row['updated_at'] ?? null,
            'score' => $score ?? ($row['score'] ?? null),
        ];
    }

    private function generateKey(): string
    {
        $bytes = random_bytes(16);
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);

        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($bytes), 4));
    }

    private function hostId(?array $host): ?int
    {
        return isset($host['id']) && is_numeric($host['id']) ? (int) $host['id'] : null;
    }
}
