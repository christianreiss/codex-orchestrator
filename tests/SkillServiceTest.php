<?php

declare(strict_types=1);

use App\Repositories\SkillRepository;
use App\Repositories\LogRepository;
use App\Services\SkillService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemorySkillRepository extends SkillRepository
{
    /**
     * @var array<string, array>
     */
    public array $store = [];

    public function __construct()
    {
    }

    public function all(bool $includeDeleted = false): array
    {
        $rows = array_values($this->store);
        if (!$includeDeleted) {
            $rows = array_filter($rows, static fn ($row) => empty($row['deleted_at']));
        }

        usort($rows, static fn ($a, $b) => strcmp((string) $a['slug'], (string) $b['slug']));

        return array_values($rows);
    }

    public function findBySlug(string $slug): ?array
    {
        return $this->store[$slug] ?? null;
    }

    public function upsert(
        string $slug,
        string $sha256,
        ?string $displayName,
        ?string $description,
        string $manifest,
        ?int $sourceHostId
    ): array {
        $now = gmdate(DATE_ATOM);
        $createdAt = $this->store[$slug]['created_at'] ?? $now;

        $row = [
            'id' => count($this->store) + 1,
            'slug' => $slug,
            'sha256' => $sha256,
            'display_name' => $displayName,
            'description' => $description,
            'manifest' => $manifest,
            'source_host_id' => $sourceHostId,
            'created_at' => $createdAt,
            'updated_at' => $now,
            'deleted_at' => null,
        ];

        $this->store[$slug] = $row;

        return $row;
    }

    public function delete(string $slug): bool
    {
        if (!isset($this->store[$slug])) {
            return false;
        }

        $this->store[$slug]['deleted_at'] = gmdate(DATE_ATOM);

        return true;
    }
}

final class NullLogRepositorySkill extends LogRepository
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

final class SkillServiceTest extends TestCase
{
    private InMemorySkillRepository $repository;
    private NullLogRepositorySkill $logs;
    private SkillService $service;

    protected function setUp(): void
    {
        $this->repository = new InMemorySkillRepository();
        $this->logs = new NullLogRepositorySkill();
        $this->service = new SkillService($this->repository, $this->logs);
    }

    public function testStoreCreatesSkill(): void
    {
        $result = $this->service->store([
            'slug' => 'deploy',
            'manifest' => '{"name":"deploy","description":"deploy service"}',
        ], ['id' => 7]);

        $this->assertSame('created', $result['status']);
        $this->assertArrayHasKey('sha256', $result);
        $this->assertNotEmpty($this->repository->findBySlug('deploy'));
        $this->assertSame('skill.store', $this->logs->records[0]['action']);
    }

    public function testStoreDetectsUnchanged(): void
    {
        $payload = [
            'slug' => 'backup',
            'manifest' => '{"name":"backup"}',
            'display_name' => 'Nightly backup',
        ];
        $first = $this->service->store($payload, null);
        $this->assertSame('created', $first['status']);

        $second = $this->service->store($payload, null);
        $this->assertSame('unchanged', $second['status']);

        $metadataChange = $payload;
        $metadataChange['description'] = 'Backups nightly';
        $third = $this->service->store($metadataChange, null);
        $this->assertSame('updated', $third['status']);
    }

    public function testRetrieveRespectsSha(): void
    {
        $payload = [
            'slug' => 'lint',
            'manifest' => '{"cmd":"composer lint"}',
        ];
        $store = $this->service->store($payload, null);
        $sha = $store['sha256'];

        $unchanged = $this->service->retrieve('lint', $sha, null);
        $this->assertSame('unchanged', $unchanged['status']);
        $this->assertArrayNotHasKey('manifest', $unchanged);

        $updated = $this->service->retrieve('lint', null, null);
        $this->assertSame('updated', $updated['status']);
        $this->assertSame($payload['manifest'], $updated['manifest']);
    }

    public function testDeleteMarksSkill(): void
    {
        $this->service->store(['slug' => 'cleanup', 'manifest' => '{}'], null);
        $deleted = $this->service->delete('cleanup', null);

        $this->assertTrue($deleted);
        $row = $this->repository->findBySlug('cleanup');
        $this->assertNotNull($row['deleted_at']);
    }
}
