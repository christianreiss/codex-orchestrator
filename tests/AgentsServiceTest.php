<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
use App\Repositories\AgentsRepository;
use App\Repositories\LogRepository;
use App\Services\AgentsService;
use App\Services\ClientConfigService;
use App\Services\MemoryService;
use App\Services\SkillService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InMemoryAgentsRepository extends AgentsRepository
{
    /** @var array<int, array> */
    public array $versions = [];
    public array $stateRow = [];
    private int $nextId = 1;

    public function __construct()
    {
    }

    public function latest(): ?array
    {
        if (empty($this->versions)) {
            return null;
        }
        $sorted = $this->versions;
        usort($sorted, static fn($a, $b) => $b['id'] <=> $a['id']);
        return $sorted[0];
    }

    public function findById(int $id): ?array
    {
        return $this->versions[$id] ?? null;
    }

    public function listVersions(int $limit = 50): array
    {
        $sorted = $this->versions;
        usort($sorted, static fn($a, $b) => $b['id'] <=> $a['id']);
        return array_slice($sorted, 0, $limit);
    }

    public function createVersion(string $body, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $now = gmdate(DATE_ATOM);
        $id = $this->nextId++;
        $row = [
            'id' => $id,
            'sha256' => $sha256 ?? hash('sha256', $body),
            'body' => $body,
            'source_host_id' => $sourceHostId,
            'created_at' => $now,
            'updated_at' => $now,
        ];
        $this->versions[$id] = $row;
        return $row;
    }

    public function storeVersionIfChanged(string $body, ?int $sourceHostId = null, ?string $sha256 = null): array
    {
        $latest = $this->latest();
        $sha = $sha256 ?? hash('sha256', $body);

        if (is_array($latest) && hash_equals((string) ($latest['sha256'] ?? ''), $sha)) {
            return [
                'status' => 'unchanged',
                'row' => $latest,
            ];
        }

        return [
            'status' => is_array($latest) ? 'updated' : 'created',
            'row' => $this->createVersion($body, $sourceHostId, $sha),
        ];
    }

    public function deleteVersion(int $id): bool
    {
        if (!isset($this->versions[$id])) {
            return false;
        }
        unset($this->versions[$id]);
        return true;
    }

    public function state(): array
    {
        if (empty($this->stateRow)) {
            $now = gmdate(DATE_ATOM);
            $this->stateRow = [
                'id' => self::STATE_ID,
                'mode' => self::MODE_LATEST,
                'active_document_id' => null,
                'created_at' => $now,
                'updated_at' => $now,
            ];
        }
        return $this->stateRow;
    }

    public function updateState(string $mode, ?int $activeId): array
    {
        $this->state();
        $this->stateRow['mode'] = $mode;
        $this->stateRow['active_document_id'] = $activeId;
        $this->stateRow['updated_at'] = gmdate(DATE_ATOM);
        return $this->stateRow;
    }
}

final class NullLogRepositoryAgents extends LogRepository
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

final class FakeSkillServiceForAgents extends SkillService
{
    public array $skills = [];

    public function __construct()
    {
    }

    public function listForAgents(): array
    {
        return $this->skills;
    }
}

final class FakeClientConfigServiceForAgents extends ClientConfigService
{
    public array $state = ['status' => 'missing'];

    public function __construct()
    {
    }

    public function adminFetch(): array
    {
        return $this->state;
    }
}

final class FakeMemoryServiceForAgents extends MemoryService
{
    public array $memories = [];

    public function __construct()
    {
    }

    public function listForAgentsDocument(array $host, int $limit = 50): array
    {
        return $this->memories;
    }
}

final class AgentsServiceTest extends TestCase
{
    private InMemoryAgentsRepository $repository;
    private NullLogRepositoryAgents $logs;
    private FakeSkillServiceForAgents $skills;
    private FakeClientConfigServiceForAgents $configs;
    private FakeMemoryServiceForAgents $memories;
    private AgentsService $service;

    protected function setUp(): void
    {
        $this->repository = new InMemoryAgentsRepository();
        $this->logs = new NullLogRepositoryAgents();
        $this->skills = new FakeSkillServiceForAgents();
        $this->configs = new FakeClientConfigServiceForAgents();
        $this->memories = new FakeMemoryServiceForAgents();
        $this->service = new AgentsService($this->repository, $this->logs, $this->skills, $this->configs, $this->memories);
    }

    public function testRetrieveMissingReturnsStatus(): void
    {
        $result = $this->service->retrieve(null);
        $this->assertSame('missing', $result['status']);
    }

    public function testStoreCreatesFirstVersion(): void
    {
        $result = $this->service->store('# AGENTS.md content', null, ['id' => 1]);
        $this->assertSame('created', $result['status']);
        $this->assertArrayHasKey('sha256', $result);
        $this->assertArrayHasKey('version_id', $result);
    }

    public function testStoreDetectsUnchanged(): void
    {
        $content = '# AGENTS v1';
        $this->service->store($content);

        $result = $this->service->store($content);
        $this->assertSame('unchanged', $result['status']);
    }

    public function testStoreDetectsUpdated(): void
    {
        $this->service->store('# AGENTS v1');
        $result = $this->service->store('# AGENTS v2');
        $this->assertSame('updated', $result['status']);
    }

    public function testStoreDetectsUnchangedEvenWhenServeModeIsLockedToOlderVersion(): void
    {
        $v1 = $this->service->store('# AGENTS v1');
        $v2 = $this->service->store('# AGENTS v2 latest');
        $this->service->setServeMode('locked', $v1['version_id']);

        $result = $this->service->store('# AGENTS v2 latest');

        $this->assertSame('unchanged', $result['status']);
        $this->assertSame($v2['version_id'], $result['version_id']);
        $this->assertCount(2, $this->repository->versions);
    }

    public function testStoreRejectsInvalidSha(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store('# Content', 'not-a-sha');
    }

    public function testStoreRejectsMismatchedSha(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->store('# Content', str_repeat('a', 64));
    }

    public function testStoreAcceptsMatchingSha(): void
    {
        $content = '# Valid';
        $sha = hash('sha256', $content);
        $result = $this->service->store($content, $sha);
        $this->assertSame('created', $result['status']);
    }

    public function testRetrieveUnchangedWhenShaMatches(): void
    {
        $content = '# AGENTS content';
        $store = $this->service->store($content);
        $sha = $store['sha256'];

        $result = $this->service->retrieve($sha);
        $this->assertSame('unchanged', $result['status']);
        $this->assertArrayNotHasKey('content', $result);
    }

    public function testRetrieveUpdatedWhenShaDiffers(): void
    {
        $this->service->store('# AGENTS content');

        $result = $this->service->retrieve(null);
        $this->assertSame('updated', $result['status']);
        $this->assertSame('# AGENTS content', $result['content']);
    }

    public function testRetrieveAppendsSkillsBlockWhenMcpEnabledAndSkillsExist(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => true],
        ];
        $this->skills->skills = [
            ['slug' => 'deploy', 'description' => 'Deploys services safely.'],
            ['slug' => 'triage', 'description' => null],
        ];

        $result = $this->service->retrieve(null);

        $this->assertStringContainsString('## Skills', $result['content']);
        $this->assertStringContainsString('`deploy` - Deploys services safely.', $result['content']);
        $this->assertStringContainsString('`triage` - Skill available via MCP; open `skill://triage` for details.', $result['content']);
        $this->assertStringContainsString('<!-- cdx:skills:start -->', $result['content']);
        $this->assertSame(true, $result['sections']['skills']['present'] ?? null);
        $this->assertSame(2, $result['sections']['skills']['count'] ?? null);
        $this->assertSame('ok', $result['sections']['skills']['reason'] ?? null);
    }

    public function testRetrieveSkipsSkillsBlockWhenConfigMissing(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->skills->skills = [
            ['slug' => 'deploy', 'description' => 'Deploys services safely.'],
        ];

        $result = $this->service->retrieve(null);

        $this->assertStringNotContainsString('## Skills', $result['content']);
    }

    public function testRetrieveSkipsSkillsBlockWhenMcpDisabled(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => false],
        ];
        $this->skills->skills = [
            ['slug' => 'deploy', 'description' => 'Deploys services safely.'],
        ];

        $result = $this->service->retrieve(null);

        $this->assertStringNotContainsString('## Skills', $result['content']);
    }

    public function testRetrieveHashChangesWhenSkillsBlockChanges(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => true],
        ];
        $this->skills->skills = [
            ['slug' => 'deploy', 'description' => 'Deploys services safely.'],
        ];

        $first = $this->service->retrieve(null);
        $this->skills->skills[0]['description'] = 'Deploys services with safety checks.';
        $second = $this->service->retrieve(null);

        $this->assertNotSame($first['sha256'], $second['sha256']);
    }

    public function testRetrieveAppendsMemoriesBlockWhenMcpEnabledAndMemoriesExist(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => true],
        ];
        $this->memories->memories = [
            ['memory_key' => 'deploy.notes', 'summary' => 'Records rollout gotchas and manual checks.'],
            ['memory_key' => 'handoff', 'summary' => null],
        ];

        $result = $this->service->retrieve(null, ['id' => 11]);

        $this->assertStringContainsString('## Memories', $result['content']);
        $this->assertStringContainsString('`deploy.notes` - Records rollout gotchas and manual checks.', $result['content']);
        $this->assertStringContainsString('`handoff` - Memory stored under key `handoff`.', $result['content']);
        $this->assertStringContainsString('<!-- cdx:memories:start -->', $result['content']);
        $this->assertSame(true, $result['sections']['memories']['present'] ?? null);
        $this->assertSame(2, $result['sections']['memories']['count'] ?? null);
        $this->assertSame(1, $result['sections']['memories']['fallback_count'] ?? null);
        $this->assertSame('ok', $result['sections']['memories']['reason'] ?? null);
    }

    public function testRetrieveSkipsMemoriesBlockWhenHostMissing(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => true],
        ];
        $this->memories->memories = [
            ['memory_key' => 'deploy.notes', 'summary' => 'Records rollout gotchas and manual checks.'],
        ];

        $result = $this->service->retrieve(null);

        $this->assertStringNotContainsString('## Memories', $result['content']);
        $this->assertSame(false, $result['sections']['memories']['present'] ?? null);
        $this->assertSame('host_missing', $result['sections']['memories']['reason'] ?? null);
    }

    public function testRetrieveReportsNoMemoriesReasonWhenNoneExist(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => true],
        ];

        $result = $this->service->retrieve(null, ['id' => 11]);

        $this->assertStringNotContainsString('## Memories', $result['content']);
        $this->assertSame(false, $result['sections']['memories']['present'] ?? null);
        $this->assertSame(0, $result['sections']['memories']['count'] ?? null);
        $this->assertSame('no_memories', $result['sections']['memories']['reason'] ?? null);
    }

    public function testRetrieveReportsDisabledManagedSectionsWhenMcpDisabled(): void
    {
        $this->service->store("# Base AGENTS\n");
        $this->configs->state = [
            'status' => 'ok',
            'settings' => ['orchestrator_mcp_enabled' => false],
        ];

        $result = $this->service->retrieve(null, ['id' => 11]);

        $this->assertSame('mcp_disabled', $result['sections']['skills']['reason'] ?? null);
        $this->assertSame('mcp_disabled', $result['sections']['memories']['reason'] ?? null);
    }

    public function testAdminFetchWhenMissing(): void
    {
        $result = $this->service->adminFetch();
        $this->assertSame('missing', $result['status']);
        $this->assertArrayHasKey('versions', $result);
    }

    public function testAdminFetchWithContent(): void
    {
        $this->service->store('# Admin content');
        $result = $this->service->adminFetch();

        $this->assertSame('ok', $result['status']);
        $this->assertSame('# Admin content', $result['content']);
        $this->assertCount(1, $result['versions']);
        $this->assertTrue($result['versions'][0]['is_latest']);
    }

    public function testSetServeModeLatest(): void
    {
        $this->service->store('# Content');
        $result = $this->service->setServeMode('latest');
        $this->assertSame('latest', $result['mode']);
    }

    public function testSetServeModeLocked(): void
    {
        $stored = $this->service->store('# Content');
        $versionId = $stored['version_id'];

        $result = $this->service->setServeMode('locked', $versionId);
        $this->assertSame('locked', $result['mode']);
    }

    public function testSetServeModeLockedWithoutIdThrows(): void
    {
        $this->service->store('# Content');

        $this->expectException(ValidationException::class);
        $this->service->setServeMode('locked');
    }

    public function testSetServeModeInvalidThrows(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->setServeMode('invalid');
    }

    public function testSetServeModeLockedWithBadIdThrows(): void
    {
        $this->service->store('# Content');

        $this->expectException(ValidationException::class);
        $this->service->setServeMode('locked', 9999);
    }

    public function testAdminFetchVersionReturnsStoredContentAndFlags(): void
    {
        $v1 = $this->service->store('# V1');
        $this->service->store('# V2 latest');
        $this->service->setServeMode('locked', $v1['version_id']);

        $result = $this->service->adminFetchVersion($v1['version_id']);
        $this->assertSame($v1['version_id'], $result['id']);
        $this->assertSame('# V1', $result['content']);
        $this->assertTrue($result['is_active']);
        $this->assertTrue($result['is_served']);
        $this->assertFalse($result['is_latest']);
    }

    public function testAdminFetchVersionRejectsMissingVersion(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->adminFetchVersion(9999);
    }

    public function testRevertVersionCreatesNewLatestAndResetsServeMode(): void
    {
        $v1 = $this->service->store('# V1');
        $this->service->store('# V2 latest');
        $this->service->setServeMode('locked', $v1['version_id']);

        $result = $this->service->revertVersion($v1['version_id']);

        $this->assertSame('latest', $result['mode']);
        $this->assertNull($result['active_id']);
        $this->assertSame($result['latest_id'], $result['served_id']);
        $this->assertSame('# V1', $result['content']);
        $this->assertCount(3, $result['versions']);
        $this->assertNotSame($v1['version_id'], $result['latest_id']);
    }

    public function testRevertVersionRejectsMissingVersion(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->revertVersion(9999);
    }

    public function testDeleteVersion(): void
    {
        $v1 = $this->service->store('# V1');
        $v2 = $this->service->store('# V2');

        // V2 is the served (latest) version, so delete V1
        $result = $this->service->deleteVersion($v1['version_id']);
        $this->assertSame('ok', $result['status']);
        $this->assertCount(1, $result['versions']);
    }

    public function testDeleteServedVersionThrows(): void
    {
        $stored = $this->service->store('# Only version');

        $this->expectException(ValidationException::class);
        $this->service->deleteVersion($stored['version_id']);
    }

    public function testDeleteNonexistentVersionThrows(): void
    {
        $this->service->store('# Content');

        $this->expectException(ValidationException::class);
        $this->service->deleteVersion(9999);
    }

    public function testDeleteVersionZeroThrows(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->deleteVersion(0);
    }

    public function testRetrieveUsesHostOverride(): void
    {
        $v1 = $this->service->store('# V1');
        $this->service->store('# V2');

        $result = $this->service->retrieve(null, ['id' => 1, 'agents_document_id_override' => $v1['version_id']]);
        $this->assertSame('updated', $result['status']);
        $this->assertSame('# V1', $result['content']);
    }

    public function testRetrieveLockedMode(): void
    {
        $v1 = $this->service->store('# V1');
        $this->service->store('# V2 latest');
        $this->service->setServeMode('locked', $v1['version_id']);

        $result = $this->service->retrieve(null);
        $this->assertSame('updated', $result['status']);
        $this->assertSame('# V1', $result['content']);
    }

    public function testEnsureSeededFromFileCreatesOrUpdatesCanonicalAgentsVersion(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'agents-seed-');
        $this->assertNotFalse($path);
        file_put_contents($path, '# Seeded AGENTS');

        try {
            $created = $this->service->ensureSeededFromFile($path);
            $this->assertSame('created', $created['status']);
            $this->assertSame('# Seeded AGENTS', $this->repository->latest()['body']);

            $unchanged = $this->service->ensureSeededFromFile($path);
            $this->assertSame('unchanged', $unchanged['status']);

            file_put_contents($path, '# Seeded AGENTS v2');
            $updated = $this->service->ensureSeededFromFile($path);
            $this->assertSame('updated', $updated['status']);
            $this->assertSame('# Seeded AGENTS v2', $this->repository->latest()['body']);
        } finally {
            @unlink($path);
        }
    }
}
