<?php

declare(strict_types=1);

use App\Repositories\SkillRepository;
use App\Repositories\LogRepository;
use App\Services\ProjectModuleService;
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

final class FakeProjectModuleService extends ProjectModuleService
{
    public bool $enabled = true;

    public function __construct()
    {
    }

    public function isEnabled(): bool
    {
        return $this->enabled;
    }

    public function adminState(): array
    {
        return [
            'enabled' => $this->enabled,
            'updated_at' => '2026-03-12T10:00:00Z',
            'managed_skill' => [
                'slug' => self::MANAGED_SKILL_SLUG,
                'display_name' => 'CoCo Projects',
                'description' => 'Managed project coordination skill',
            ],
        ];
    }

    public function setEnabled(bool $enabled): array
    {
        $this->enabled = $enabled;

        return $this->adminState();
    }

    public function managedSkill(): ?array
    {
        if (!$this->enabled) {
            return null;
        }

        $manifest = "# Managed CoCo\n";

        return [
            'id' => null,
            'slug' => self::MANAGED_SKILL_SLUG,
            'sha256' => hash('sha256', $manifest),
            'display_name' => 'CoCo Projects',
            'description' => 'Managed project coordination skill',
            'manifest' => $manifest,
            'updated_at' => '2026-03-12T10:00:00Z',
            'deleted_at' => null,
            'managed' => true,
        ];
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
        $this->assertSame('skill://lint', $unchanged['uri']);
        $this->assertArrayNotHasKey('manifest', $unchanged);
        $this->assertSame('skill://lint', $unchanged['canonical_uri']);
        $this->assertArrayNotHasKey('fallback_path', $unchanged);
        $this->assertArrayNotHasKey('legacy_fallback_path', $unchanged);

        $updated = $this->service->retrieve('lint', null, null);
        $this->assertSame('updated', $updated['status']);
        $this->assertSame('skill://lint', $updated['uri']);
        $this->assertSame($payload['manifest'], $updated['manifest']);
    }

    public function testListAndFindExposeCanonicalSkillUris(): void
    {
        $this->service->store([
            'slug' => 'deploy',
            'manifest' => '# Deploy',
        ], null);

        $listed = $this->service->listSkills();
        $found = $this->service->find('deploy');

        $this->assertSame('skill://deploy', $listed[0]['canonical_uri']);
        $this->assertSame('skill://deploy', $found['canonical_uri']);
        $this->assertArrayNotHasKey('fallback_path', $listed[0]);
        $this->assertArrayNotHasKey('legacy_fallback_path', $listed[0]);
        $this->assertArrayNotHasKey('fallback_path', $found);
        $this->assertArrayNotHasKey('legacy_fallback_path', $found);
    }

    public function testDeleteMarksSkill(): void
    {
        $this->service->store(['slug' => 'cleanup', 'manifest' => '{}'], null);
        $deleted = $this->service->delete('cleanup', null);

        $this->assertTrue($deleted);
        $row = $this->repository->findBySlug('cleanup');
        $this->assertNotNull($row['deleted_at']);
    }

    public function testListSkillsIncludesManagedCocoSkillWhenProjectModuleEnabled(): void
    {
        $service = new SkillService($this->repository, $this->logs, new FakeProjectModuleService());

        $skills = $service->listSkills();

        $this->assertCount(1, $skills);
        $this->assertSame('coco', $skills[0]['slug']);
        $this->assertSame('skill://coco', $skills[0]['uri']);
        $this->assertSame('CoCo Projects', $skills[0]['display_name']);
        $this->assertArrayHasKey('managed', $skills[0]);
    }

    public function testStoreRejectsManagedCocoSkillSlugWhileProjectModuleEnabled(): void
    {
        $service = new SkillService($this->repository, $this->logs, new FakeProjectModuleService());

        $this->expectException(\App\Exceptions\ValidationException::class);

        $service->store([
            'slug' => 'coco',
            'manifest' => '# custom',
        ], null);
    }
}
