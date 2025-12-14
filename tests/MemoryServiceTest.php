<?php

declare(strict_types=1);

use App\Repositories\LogRepository;
use App\Repositories\MemoryRepository;
use App\Services\MemoryService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryMemoryRepository extends MemoryRepository
{
    public array $store = [];

    public function __construct()
    {
    }

    public function upsert(int $hostId, string $memoryKey, string $content, ?array $metadata, array $tags): array
    {
        $now = gmdate(DATE_ATOM);
        $existing = $this->findByKey($hostId, $memoryKey);
        $createdAt = $existing['created_at'] ?? $now;

        $row = [
            'id' => count($this->store[$hostId] ?? []) + 1,
            'host_id' => $hostId,
            'memory_key' => $memoryKey,
            'content' => $content,
            'metadata' => $metadata,
            'tags' => $tags,
            'created_at' => $createdAt,
            'updated_at' => $now,
            'deleted_at' => null,
            'score' => null,
        ];

        $this->store[$hostId][$memoryKey] = $row;

        return $row;
    }

    public function findByKey(int $hostId, string $memoryKey): ?array
    {
        $row = $this->store[$hostId][$memoryKey] ?? null;

        if ($row !== null && ($row['deleted_at'] ?? null) !== null) {
            return null;
        }

        return $row;
    }

    public function recent(int $hostId, int $limit): array
    {
        $rows = array_values($this->store[$hostId] ?? []);
        usort($rows, static fn ($a, $b) => strcmp($b['updated_at'], $a['updated_at']));

        return array_slice($rows, 0, $limit);
    }

    public function search(int $hostId, string $query, int $limit): array
    {
        $queryLower = strtolower($query);
        $matches = [];
        foreach ($this->store[$hostId] ?? [] as $row) {
            if (($row['deleted_at'] ?? null) !== null) {
                continue;
            }
            $haystack = strtolower($row['content'] . ' ' . implode(' ', $row['tags'] ?? []));
            $found = $queryLower === '' || str_contains($haystack, $queryLower);
            if ($found) {
                $row['score'] = $queryLower === '' ? null : (float) strlen($queryLower) / max(1, strlen($row['content']));
                $matches[] = $row;
            }
        }

        usort($matches, static function ($a, $b): int {
            $scoreA = $a['score'] ?? 0.0;
            $scoreB = $b['score'] ?? 0.0;
            if ($scoreA === $scoreB) {
                return strcmp($b['updated_at'], $a['updated_at']);
            }
            return $scoreB <=> $scoreA;
        });

        return array_slice($matches, 0, $limit);
    }

    public function deleteById(int $id): void
    {
        foreach ($this->store as $hostId => $rows) {
            foreach ($rows as $key => $row) {
                if (($row['id'] ?? null) === $id) {
                    $this->store[$hostId][$key]['deleted_at'] = gmdate(DATE_ATOM);
                    return;
                }
            }
        }
    }
}

final class NullLogRepositoryMem extends LogRepository
{
    public array $records = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->records[] = [
            'host_id' => $hostId,
            'action' => $action,
            'details' => $details,
        ];
    }
}

final class MemoryServiceTest extends TestCase
{
    private InMemoryMemoryRepository $repository;
    private NullLogRepositoryMem $logs;
    private MemoryService $service;
    private array $host;

    protected function setUp(): void
    {
        $this->repository = new InMemoryMemoryRepository();
        $this->logs = new NullLogRepositoryMem();
        $this->service = new MemoryService($this->repository, $this->logs);
        $this->host = ['id' => 42, 'fqdn' => 'example.test'];
    }

    public function testStoreCreatesMemoryAndGeneratesId(): void
    {
        $result = $this->service->store(['content' => 'first note'], $this->host);

        $this->assertSame('created', $result['status']);
        $this->assertNotEmpty($result['id']);
        $this->assertSame('first note', $result['memory']['content']);
        $this->assertNotEmpty($result['memory']['record_id']);
        $this->assertSame([], $result['memory']['tags']);
        $this->assertCount(1, $this->logs->records);
    }

    public function testStoreUpdatesWhenContentChanges(): void
    {
        $payload = ['id' => 'memo-1', 'content' => 'alpha'];
        $first = $this->service->store($payload, $this->host);
        $this->assertSame('created', $first['status']);

        $second = $this->service->store(['id' => 'memo-1', 'content' => 'alpha prime'], $this->host);
        $this->assertSame('updated', $second['status']);
        $this->assertSame('alpha prime', $this->repository->findByKey($this->host['id'], 'memo-1')['content']);

        $third = $this->service->store(['id' => 'memo-1', 'content' => 'alpha prime'], $this->host);
        $this->assertSame('unchanged', $third['status']);
    }

    public function testSearchFiltersByQueryAndTags(): void
    {
        $this->service->store(['id' => 'a', 'content' => 'fix the bug', 'tags' => ['dev', 'bug']], $this->host);
        $this->service->store(['id' => 'b', 'content' => 'write docs', 'tags' => ['docs']], $this->host);
        $this->service->store(['id' => 'c', 'content' => 'bug triage', 'tags' => ['bug']], $this->host);

        $result = $this->service->search(['query' => 'bug', 'tags' => ['bug'], 'limit' => 5], $this->host);

        $this->assertSame('ok', $result['status']);
        $this->assertCount(2, $result['matches']);
        $ids = array_column($result['matches'], 'id');
        $this->assertContains('a', $ids);
        $this->assertContains('c', $ids);
    }

    public function testDeleteRemovesMemoryForHost(): void
    {
        $created = $this->service->store(['id' => 'note-del', 'content' => 'remove me'], $this->host);
        $this->assertSame('created', $created['status']);

        $deleted = $this->service->delete(['id' => 'note-del'], $this->host);

        $this->assertSame('deleted', $deleted['status']);
        $this->assertSame('note-del', $deleted['id']);
        $this->assertNull($this->repository->findByKey($this->host['id'], 'note-del'));
        $this->assertSame('memory.delete', $this->logs->records[array_key_last($this->logs->records)]['action']);
    }
}
