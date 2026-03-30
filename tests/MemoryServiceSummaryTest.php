<?php

declare(strict_types=1);

use App\Repositories\LogRepository;
use App\Repositories\MemoryRepository;
use App\Services\MemoryService;
use App\Services\MemorySummaryService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryMemoryRepositoryForSummary extends MemoryRepository
{
    /** @var array<string, array{id:int,host_id:int,memory_key:string,content:string,metadata:?array,tags:array,summary:?string,created_at:string,updated_at:string}> */
    public array $rows = [];
    private int $nextId = 1;

    public function __construct()
    {
    }

    public function upsert(
        int $hostId,
        string $memoryKey,
        string $content,
        ?array $metadata,
        array $tags,
        ?string $summary = null
    ): array {
        $now = gmdate(DATE_ATOM);
        $row = $this->rows[$memoryKey] ?? [
            'id' => $this->nextId++,
            'host_id' => $hostId,
            'memory_key' => $memoryKey,
            'created_at' => $now,
        ];

        $row['content'] = $content;
        $row['metadata'] = $metadata;
        $row['tags'] = array_values($tags);
        $row['summary'] = $summary;
        $row['updated_at'] = $now;
        $this->rows[$memoryKey] = $row;

        return $row;
    }

    public function findByKey(int $hostId, string $memoryKey): ?array
    {
        return $this->rows[$memoryKey] ?? null;
    }

    public function recent(int $hostId, int $limit): array
    {
        $rows = array_values(array_filter(
            $this->rows,
            static fn (array $row): bool => (int) ($row['host_id'] ?? 0) === $hostId
        ));
        usort($rows, static fn (array $a, array $b): int => strcmp((string) $b['updated_at'], (string) $a['updated_at']));

        return array_slice($rows, 0, $limit);
    }

    public function updateSummary(int $id, string $summary): void
    {
        foreach ($this->rows as $key => $row) {
            if (($row['id'] ?? null) !== $id) {
                continue;
            }

            $row['summary'] = $summary;
            $row['updated_at'] = gmdate(DATE_ATOM);
            $this->rows[$key] = $row;
            return;
        }
    }
}

final class NullLogRepositoryMemoryServiceSummary extends LogRepository
{
    public array $records = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->records[] = compact('hostId', 'action', 'details');
    }
}

final class StubMemorySummaryServiceForMemoryService extends MemorySummaryService
{
    public array $calls = [];
    public ?string $result = 'Stores deployment notes.';

    public function __construct()
    {
    }

    public function summarize(string $memoryKey, string $content, ?array $host = null): ?string
    {
        $this->calls[] = compact('memoryKey', 'content', 'host');

        return $this->result;
    }
}

final class MemoryServiceSummaryTest extends TestCase
{
    private InMemoryMemoryRepositoryForSummary $repository;
    private NullLogRepositoryMemoryServiceSummary $logs;
    private StubMemorySummaryServiceForMemoryService $summary;
    private MemoryService $service;

    protected function setUp(): void
    {
        $this->repository = new InMemoryMemoryRepositoryForSummary();
        $this->logs = new NullLogRepositoryMemoryServiceSummary();
        $this->summary = new StubMemorySummaryServiceForMemoryService();
        $this->service = new MemoryService($this->repository, $this->logs, $this->summary);
    }

    public function testStorePreservesExistingSummaryOnUnchangedWrite(): void
    {
        $host = ['id' => 7];
        $this->service->store([
            'id' => 'deploy.notes',
            'content' => 'Drain queue before rollout.',
            'tags' => ['deploy'],
        ], $host);

        $this->summary->calls = [];
        $result = $this->service->store([
            'id' => 'deploy.notes',
            'content' => 'Drain queue before rollout.',
            'tags' => ['deploy'],
        ], $host);

        self::assertSame('unchanged', $result['status']);
        self::assertSame('Stores deployment notes.', $result['memory']['summary'] ?? null);
        self::assertCount(0, $this->summary->calls);
    }

    public function testStoreBackfillsMissingSummaryOnUnchangedWrite(): void
    {
        $host = ['id' => 7];
        $this->summary->result = null;
        $this->service->store([
            'id' => 'deploy.notes',
            'content' => 'Drain queue before rollout.',
            'tags' => ['deploy'],
        ], $host);

        $this->summary->result = 'Stores deployment notes.';
        $this->summary->calls = [];
        $result = $this->service->store([
            'id' => 'deploy.notes',
            'content' => 'Drain queue before rollout.',
            'tags' => ['deploy'],
        ], $host);

        self::assertSame('unchanged', $result['status']);
        self::assertSame('Stores deployment notes.', $result['memory']['summary'] ?? null);
        self::assertCount(1, $this->summary->calls);
    }

    public function testListForAgentsDocumentBackfillsMissingSummaryOnRead(): void
    {
        $host = ['id' => 7];
        $this->summary->result = null;
        $this->service->store([
            'id' => 'deploy.notes',
            'content' => 'Drain queue before rollout.',
            'tags' => ['deploy'],
        ], $host);

        $this->summary->result = 'Stores deployment notes.';
        $this->summary->calls = [];

        $memories = $this->service->listForAgentsDocument($host);

        self::assertCount(1, $memories);
        self::assertSame('Stores deployment notes.', $memories[0]['summary'] ?? null);
        self::assertSame('Stores deployment notes.', $this->repository->rows['deploy.notes']['summary'] ?? null);
        self::assertCount(1, $this->summary->calls);
    }

    public function testListForAgentsDocumentKeepsMemoryVisibleWhenSummaryGenerationFails(): void
    {
        $host = ['id' => 7];
        $this->summary->result = null;
        $this->service->store([
            'id' => 'deploy.notes',
            'content' => 'Drain queue before rollout.',
            'tags' => ['deploy'],
        ], $host);

        $this->summary->calls = [];
        $memories = $this->service->listForAgentsDocument($host);

        self::assertCount(1, $memories);
        self::assertNull($memories[0]['summary'] ?? null);
        self::assertCount(1, $this->summary->calls);
    }
}
