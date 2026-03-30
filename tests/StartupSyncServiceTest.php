<?php

declare(strict_types=1);

use App\Services\AgentsService;
use App\Services\ClientConfigService;
use App\Services\StartupSyncService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class StartupSyncServiceTest extends TestCase
{
    private function createService(
        array $agentsRetrieve = ['status' => 'missing'],
        array $configRetrieve = ['status' => 'missing']
    ): StartupSyncService {
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

        return new StartupSyncService($agents, $configs);
    }

    public function testAllUnchangedReturnsOk(): void
    {
        $service = $this->createService();

        $result = $service->collect(
            [],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertSame('ok', $result['status']);
        $this->assertEmpty($result['reasons']);
    }

    public function testAgentsChangedTriggersUpdate(): void
    {
        $service = $this->createService(
            agentsRetrieve: [
                'status' => 'updated',
                'content' => '# New',
                'sha256' => 'abc',
                'base_sha256' => 'base',
                'managed_sha256' => 'managed',
                'sections' => [
                    'skills' => ['present' => true, 'count' => 3, 'reason' => 'ok'],
                    'memories' => ['present' => false, 'count' => 0, 'reason' => 'no_memories'],
                ],
                'updated_at' => null,
                'size_bytes' => 5,
            ],
        );

        $result = $service->collect(
            ['agents' => ['sha256' => str_repeat('0', 64)]],
            ['id' => 1],
            'https://example.com',
            'key-123'
        );

        $this->assertContains('agents_changed', $result['reasons']);
        $this->assertSame('base', $result['agents']['base_sha256']);
        $this->assertSame('managed', $result['agents']['managed_sha256']);
        $this->assertSame('no_memories', $result['agents']['sections']['memories']['reason']);
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

        $this->assertArrayHasKey('agents', $result);
        $this->assertArrayHasKey('config', $result);
    }
}
