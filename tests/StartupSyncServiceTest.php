<?php

declare(strict_types=1);

use App\Services\AgentsService;
use App\Services\ClientConfigService;
use App\Services\SkillService;
use App\Services\SlashCommandService;
use App\Services\StartupSyncService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class StartupSyncServiceTest extends TestCase
{
    private function createService(
        array $slashRows = [],
        array $skillRows = [],
        array $agentsRetrieve = ['status' => 'missing'],
        array $configRetrieve = ['status' => 'missing']
    ): StartupSyncService {
        $slashCommands = $this->getMockBuilder(SlashCommandService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['listCommands', 'find'])
            ->getMock();
        $slashCommands->method('listCommands')->willReturn($slashRows);
        $slashCommands->method('find')->willReturnCallback(function (string $filename) use ($slashRows) {
            foreach ($slashRows as $row) {
                if (($row['filename'] ?? '') === $filename) {
                    return $row;
                }
            }
            return null;
        });

        $skills = $this->getMockBuilder(SkillService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['listSkills', 'find'])
            ->getMock();
        $skills->method('listSkills')->willReturn($skillRows);
        $skills->method('find')->willReturn(null);

        $agents = $this->getMockBuilder(AgentsService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['retrieve'])
            ->getMock();
        $agents->method('retrieve')->willReturn($agentsRetrieve);

        $configs = $this->getMockBuilder(ClientConfigService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['retrieve'])
            ->getMock();
        $configs->method('retrieve')->willReturn($configRetrieve);

        return new StartupSyncService($slashCommands, $skills, $agents, $configs);
    }

    public function testAllUnchangedReturnsOk(): void
    {
        $sha = hash('sha256', 'prompt');
        $service = $this->createService(
            slashRows: [['filename' => 'a.md', 'sha256' => $sha, 'deleted_at' => null]],
        );

        $result = $service->collect(
            ['slash_commands' => [['filename' => 'a.md', 'sha256' => $sha]]],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertSame('ok', $result['status']);
        $this->assertEmpty($result['reasons']);
    }

    public function testNewSlashCommandTriggersUpdate(): void
    {
        $sha = hash('sha256', 'deploy prompt');
        $service = $this->createService(
            slashRows: [['filename' => 'deploy.md', 'sha256' => $sha, 'deleted_at' => null]],
        );

        $result = $service->collect(
            ['slash_commands' => []],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertSame('update', $result['status']);
        $this->assertContains('slash_commands_changed', $result['reasons']);
        $this->assertSame(1, $result['slash_commands']['changed_count']);
    }

    public function testDeletedSlashCommandDetected(): void
    {
        $sha = hash('sha256', 'content');
        $service = $this->createService(
            slashRows: [['filename' => 'old.md', 'sha256' => $sha, 'deleted_at' => '2026-01-01T00:00:00Z']],
        );

        $result = $service->collect(
            ['slash_commands' => [['filename' => 'old.md', 'sha256' => $sha]]],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertSame('update', $result['status']);
        $this->assertSame(1, $result['slash_commands']['removed_count']);
    }

    public function testAgentsChangedTriggersUpdate(): void
    {
        $service = $this->createService(
            agentsRetrieve: ['status' => 'updated', 'content' => '# New', 'sha256' => 'abc', 'updated_at' => null, 'size_bytes' => 5],
        );

        $result = $service->collect(
            ['agents' => ['sha256' => str_repeat('0', 64)]],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertContains('agents_changed', $result['reasons']);
    }

    public function testConfigChangedTriggersUpdate(): void
    {
        $service = $this->createService(
            configRetrieve: ['status' => 'updated', 'content' => 'toml', 'sha256' => 'x', 'base_sha256' => 'y', 'updated_at' => null, 'size_bytes' => 4],
        );

        $result = $service->collect(
            ['config' => ['sha256' => str_repeat('0', 64)]],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertContains('config_changed', $result['reasons']);
    }

    public function testEmptyPayloadDefaultsGracefully(): void
    {
        $service = $this->createService();
        $result = $service->collect([], ['id' => 1], 'https://example.com', 'key-123');

        $this->assertArrayHasKey('slash_commands', $result);
        $this->assertArrayHasKey('skills', $result);
        $this->assertArrayHasKey('agents', $result);
        $this->assertArrayHasKey('config', $result);
    }

    public function testSkillsChangedTriggersUpdate(): void
    {
        $sha = hash('sha256', 'skill manifest');
        $service = $this->createService(
            skillRows: [['slug' => 'deploy', 'sha256' => $sha, 'deleted_at' => null, 'managed' => false]],
        );

        $result = $service->collect(
            ['skills' => []],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertContains('skills_changed', $result['reasons']);
        $this->assertSame(1, $result['skills']['changed_count']);
        $this->assertSame('skill://deploy', $result['skills']['remote'][0]['uri']);
        $this->assertSame('skill://deploy', $result['skills']['changed'][0]['uri']);
    }
}
