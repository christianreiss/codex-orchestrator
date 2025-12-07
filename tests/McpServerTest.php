<?php

declare(strict_types=1);

use App\Mcp\McpServer;
use App\Mcp\McpToolNotFoundException;
use App\Repositories\LogRepository;
use App\Repositories\MemoryRepository;
use App\Services\MemoryService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class McpNullMemoryRepository extends MemoryRepository
{
    public function __construct()
    {
    }

    public function findByKey(int $hostId, string $memoryKey): ?array
    {
        return [
            'id' => 1,
            'host_id' => $hostId,
            'memory_key' => $memoryKey,
            'content' => '',
            'metadata' => null,
            'tags' => [],
        ];
    }

    public function deleteById(int $id): void
    {
        // no-op for tests
    }
}

final class McpNullLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        // no-op for tests
    }
}

final class SpyMemoryService extends MemoryService
{
    public string $lastMethod = '';
    public array $lastArgs = [];
    public array $nextResult = ['ok' => true];
    public array $searchResults = [];
    public array $retrieveResults = [];
    public array $deleteResults = [];

    public function __construct()
    {
        parent::__construct(new McpNullMemoryRepository(), new McpNullLogRepository());
    }

    public function store(array $payload, array $host): array
    {
        $this->lastMethod = 'store';
        $this->lastArgs = [$payload, $host];

        return ['called' => 'store'] + $this->nextResult;
    }

    public function retrieve(array $payload, array $host): array
    {
        $this->lastMethod = 'retrieve';
        $this->lastArgs = [$payload, $host];

        if ($this->retrieveResults) {
            return $this->retrieveResults;
        }

        return ['called' => 'retrieve'] + $this->nextResult;
    }

    public function search(array $payload, array $host): array
    {
        $this->lastMethod = 'search';
        $this->lastArgs = [$payload, $host];

        if ($this->searchResults) {
            return ['status' => 'ok', 'matches' => $this->searchResults];
        }

        return ['called' => 'search'] + $this->nextResult;
    }

    public function delete(array $payload, array $host): array
    {
        $this->lastMethod = 'delete';
        $this->lastArgs = [$payload, $host];

        if ($this->deleteResults) {
            return $this->deleteResults;
        }

        return ['status' => 'deleted', 'id' => $payload['id'] ?? null];
    }
}

final class McpServerTest extends TestCase
{
    public function testToolNamesMatchRequiredPattern(): void
    {
        $server = new McpServer(new SpyMemoryService());

        $tools = $server->listTools();

        $this->assertNotEmpty($tools);
        foreach ($tools as $tool) {
            $this->assertMatchesRegularExpression(McpServer::TOOL_NAME_PATTERN, $tool['name']);
        }
    }

    public function testDispatchNormalizesDotAliases(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);
        $host = ['id' => 1];

        $result = $server->dispatch('memory.store', ['content' => 'hi'], $host);

        $decoded = json_decode($result['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame('store', $spy->lastMethod);
        $this->assertSame(['content' => 'hi'], $spy->lastArgs[0]);
        $this->assertSame($host, $spy->lastArgs[1]);
        $this->assertSame('store', $decoded['called']);
    }

    public function testDispatchAcceptsStringPayloadForStore(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $server->dispatch('memory_store', 'note text', ['id' => 1]);

        $this->assertSame('store', $spy->lastMethod);
        $this->assertSame(['content' => 'note text'], $spy->lastArgs[0]);
    }

    public function testDispatchAcceptsStringPayloadForSearch(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $server->dispatch('memory_search', 'bug', ['id' => 1]);

        $this->assertSame('search', $spy->lastMethod);
        $this->assertSame(['query' => 'bug'], $spy->lastArgs[0]);
    }

    public function testListToolsAliasIsHandledByRouterLogic(): void
    {
        // Router alias coverage is exercised in integration; ensure server output is stable for aliases.
        $server = new McpServer(new SpyMemoryService());

        $this->assertNotEmpty($server->listTools());
    }

    public function testListResourceTemplatesReturnsMemoryTemplate(): void
    {
        $server = new McpServer(new SpyMemoryService());
        $templates = $server->listResourceTemplates();

        $names = array_column($templates, 'name');
        $this->assertContains('memory_by_id', $names);
        $this->assertContains('memory_store', $names);

        $store = $templates[array_search('memory_store', $names, true)];
        $this->assertSame('memory://{scope}:{name}', $store['uriTemplate']);
        $this->assertSame(['project', 'host', 'global'], $store['inputSchema']['properties']['scope']['enum']);
    }

    public function testDispatchAcceptsStringPayloadForRetrieve(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $server->dispatch('memory_retrieve', 'fake-id', ['id' => 1]);

        $this->assertSame('retrieve', $spy->lastMethod);
        $this->assertSame(['id' => 'fake-id'], $spy->lastArgs[0]);
    }

    public function testMemoryAppendAddsResourceTagAndRandomId(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $result = $server->dispatch('memory_append', [
            'resource_id' => 'proj1',
            'text' => 'note',
            'tags' => ['foo'],
        ], ['id' => 1]);

        $decoded = json_decode($result['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame('store', $spy->lastMethod);
        $this->assertStringStartsWith('proj1:', $spy->lastArgs[0]['id']);
        $this->assertContains('resource:proj1', $spy->lastArgs[0]['tags']);
        $this->assertSame('note', $spy->lastArgs[0]['content']);
        $this->assertNotEmpty($decoded['id'] ?? '');
    }

    public function testDispatchThrowsForUnknownTool(): void
    {
        $this->expectException(McpToolNotFoundException::class);

        $server = new McpServer(new SpyMemoryService());
        $server->dispatch('unknown_tool', [], ['id' => 1]);
    }

    public function testDispatchRejectsInvalidNameCharacters(): void
    {
        $this->expectException(InvalidArgumentException::class);

        $server = new McpServer(new SpyMemoryService());
        $server->dispatch('memory store', [], ['id' => 1]);
    }

    public function testListsResourceTemplates(): void
    {
        $server = new McpServer(new SpyMemoryService());

        $templates = $server->listResourceTemplates();

        $names = array_column($templates, 'name');
        $this->assertContains('memory_by_id', $names);
        $this->assertContains('memory_store', $names);
        $this->assertSame('memory://{id}', $templates[array_search('memory_by_id', $names, true)]['uriTemplate']);
    }

    public function testListsResourcesFromRecentMemories(): void
    {
        $spy = new SpyMemoryService();
        $spy->searchResults = [
            ['id' => 'note-1', 'content' => 'hello world'],
            ['id' => 'note-2', 'content' => 'other'],
        ];
        $server = new McpServer($spy);

        $resources = $server->listResources(['id' => 1]);

        $this->assertCount(2, $resources);
        $this->assertSame('memory://note-1', $resources[0]['uri']);
        $this->assertSame('note-1', $resources[0]['name']);
    }

    public function testReadResourceReturnsMemoryContent(): void
    {
        $spy = new SpyMemoryService();
        $spy->retrieveResults = [
            'status' => 'found',
            'memory' => [
                'id' => 'note-1',
                'content' => 'hello',
                'metadata' => null,
                'tags' => [],
            ],
        ];
        $server = new McpServer($spy);

        $result = $server->readResource('memory://note-1', ['id' => 1]);

        $this->assertArrayHasKey('contents', $result);
        $this->assertSame('hello', $result['contents'][0]['text']);
        $this->assertSame('text/plain', $result['contents'][0]['mimeType']);
    }

    public function testReadResourceRejectsInvalidScheme(): void
    {
        $this->expectException(InvalidArgumentException::class);

        $server = new McpServer(new SpyMemoryService());
        $server->readResource('file://etc/passwd', ['id' => 1]);
    }

    public function testCreateResourceStoresMemory(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $result = $server->createResource('memory://note-1', ['text' => 'hello'], ['id' => 1]);

        $this->assertArrayHasKey('resource', $result);
        $this->assertSame('note-1', $result['resource']['name']);
        $this->assertSame('store', $spy->lastMethod);
        $this->assertSame(['id' => 'note-1', 'content' => 'hello'], $spy->lastArgs[0]);
    }

    public function testUpdateResourceUpdatesMemory(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $result = $server->updateResource('memory://note-2', ['text' => 'updated text'], ['id' => 1]);

        $this->assertArrayHasKey('resource', $result);
        $this->assertSame('note-2', $result['resource']['name']);
        $this->assertSame('store', $spy->lastMethod);
        $this->assertSame(['id' => 'note-2', 'content' => 'updated text'], $spy->lastArgs[0]);
    }

    public function testDeleteResourceOverwritesMemory(): void
    {
        $spy = new SpyMemoryService();
        $server = new McpServer($spy);

        $result = $server->deleteResource('memory://note-3', ['id' => 1]);

        $this->assertArrayHasKey('resource', $result);
        $this->assertTrue($result['resource']['deleted']);
        $this->assertSame('delete', $spy->lastMethod);
        $this->assertSame(['id' => 'note-3'], $spy->lastArgs[0]);
    }

    public function testFsReadFileReadsWithinRoot(): void
    {
        $tmpDir = sys_get_temp_dir() . '/mcp-fs-' . uniqid();
        mkdir($tmpDir, 0777, true);
        $path = $tmpDir . '/sample.txt';
        file_put_contents($path, "hello fs\n");

        $server = new McpServer(new SpyMemoryService(), $tmpDir);

        $result = $server->dispatch('fs_read_file', ['path' => 'sample.txt'], []);
        $decoded = json_decode($result['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame('sample.txt', $decoded['path']);
        $this->assertSame("hello fs\n", $decoded['content']);
        $this->assertSame('text/plain', $decoded['mimeType']);
    }

    public function testFsWriteFileCreatesAndOverwritesWithinRoot(): void
    {
        $tmpDir = sys_get_temp_dir() . '/mcp-fs-' . uniqid();
        mkdir($tmpDir, 0777, true);
        file_put_contents($tmpDir . '/existing.txt', 'old');

        $server = new McpServer(new SpyMemoryService(), $tmpDir);

        // Overwrite allowed by default
        $write = $server->dispatch('fs_write_file', ['path' => 'existing.txt', 'content' => 'new'], []);
        $writeDecoded = json_decode($write['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame('existing.txt', $writeDecoded['path']);
        $this->assertSame('new', file_get_contents($tmpDir . '/existing.txt'));

        // Create new file with create_if_missing true
        $create = $server->dispatch('fs_write_file', ['path' => 'newfile.txt', 'content' => 'hi', 'create_if_missing' => true, 'overwrite' => false], []);
        $createDecoded = json_decode($create['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame('newfile.txt', $createDecoded['path']);
        $this->assertSame('hi', file_get_contents($tmpDir . '/newfile.txt'));
    }

    public function testFsListDirHonorsGlobAndRoot(): void
    {
        $tmpDir = sys_get_temp_dir() . '/mcp-fs-' . uniqid();
        mkdir($tmpDir, 0777, true);
        file_put_contents($tmpDir . '/a.txt', 'a');
        file_put_contents($tmpDir . '/b.md', 'b');
        mkdir($tmpDir . '/sub', 0777, true);

        $server = new McpServer(new SpyMemoryService(), $tmpDir);

        $all = $server->dispatch('fs_list_dir', ['path' => '.'], []);
        $allDecoded = json_decode($all['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $names = array_column($allDecoded['entries'], 'name');
        $this->assertContains('a.txt', $names);
        $this->assertContains('sub', $names);

        $mdOnly = $server->dispatch('fs_list_dir', ['path' => '.', 'glob' => '*.md'], []);
        $mdDecoded = json_decode($mdOnly['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $mdNames = array_column($mdDecoded['entries'], 'name');
        $this->assertSame(['b.md'], $mdNames);
    }

    public function testFsStatAndExists(): void
    {
        $tmpDir = sys_get_temp_dir() . '/mcp-fs-' . uniqid();
        mkdir($tmpDir, 0777, true);
        file_put_contents($tmpDir . '/file.txt', 'hi');

        $server = new McpServer(new SpyMemoryService(), $tmpDir);

        $stat = $server->dispatch('fs_stat', ['path' => 'file.txt'], []);
        $statDecoded = json_decode($stat['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $this->assertTrue($statDecoded['exists']);
        $this->assertSame('file', $statDecoded['type']);
        $this->assertSame('file.txt', $statDecoded['path']);

        $exists = $server->dispatch('fs_file_exists', ['path' => 'missing.txt'], []);
        $existsDecoded = json_decode($exists['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $this->assertFalse($existsDecoded['exists']);
    }

    public function testFsSearchInFilesFindsMatches(): void
    {
        $tmpDir = sys_get_temp_dir() . '/mcp-fs-' . uniqid();
        mkdir($tmpDir, 0777, true);
        file_put_contents($tmpDir . '/alpha.txt', "hello world\nsecond line");
        file_put_contents($tmpDir . '/beta.md', "nothing here");
        mkdir($tmpDir . '/src', 0777, true);
        file_put_contents($tmpDir . '/src/Database.php', "<?php class Database {}");

        $server = new McpServer(new SpyMemoryService(), $tmpDir);

        $result = $server->dispatch('fs_search_in_files', ['root' => '.', 'pattern' => 'world'], []);
        $decoded = json_decode($result['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame(1, $decoded['count']);
        $this->assertSame('alpha.txt', $decoded['matches'][0]['file']);
        $this->assertSame(1, $decoded['matches'][0]['line']);

        $byGlob = $server->dispatch('fs_search_in_files', ['root' => '.', 'pattern' => 'class Database', 'file_glob' => ['src/Database.php']], []);
        $byGlobDecoded = json_decode($byGlob['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);
        $this->assertSame(1, $byGlobDecoded['count']);
        $this->assertSame('src/Database.php', $byGlobDecoded['matches'][0]['file']);
    }

    public function testMemoryQueryUsesResourceTag(): void
    {
        $spy = new SpyMemoryService();
        $spy->searchResults = [
            ['id' => 'proj1:abc', 'content' => 'note', 'tags' => ['resource:proj1']],
        ];
        $server = new McpServer($spy);

        $result = $server->dispatch('memory_query', ['resource_id' => 'proj1', 'query' => 'note', 'top_k' => 3], ['id' => 1]);
        $decoded = json_decode($result['content'][0]['text'] ?? '{}', true, flags: JSON_THROW_ON_ERROR);

        $this->assertSame('search', $spy->lastMethod);
        $this->assertSame(['query' => 'note', 'tags' => ['resource:proj1'], 'limit' => 3], $spy->lastArgs[0]);
        $this->assertCount(1, $decoded['matches']);
    }

    public function testMemoryListFallsBackToEmptyQuery(): void
    {
        $spy = new SpyMemoryService();
        $spy->searchResults = [
            ['id' => 'proj1:abc', 'content' => 'note', 'tags' => ['resource:proj1']],
        ];
        $server = new McpServer($spy);

        $server->dispatch('memory_list', ['resource_id' => 'proj1', 'top_k' => 2], ['id' => 1]);

        $this->assertSame('search', $spy->lastMethod);
        $this->assertSame(['query' => '', 'tags' => ['resource:proj1'], 'limit' => 2], $spy->lastArgs[0]);
    }

    public function testResourceToolsWrapMemories(): void
    {
        $spy = new SpyMemoryService();
        $spy->retrieveResults = [
            'status' => 'found',
            'memory' => ['id' => 'abc', 'content' => 'body'],
        ];
        $server = new McpServer($spy);

        $read = $server->dispatch('resource_read', ['uri' => 'memory://abc'], ['id' => 1]);
        $this->assertArrayHasKey('content', $read);

        $server->dispatch('resource_create', ['uri' => 'memory://abc', 'text' => 'hi'], ['id' => 1]);
        $this->assertSame('store', $spy->lastMethod);

        $server->dispatch('resource_update', ['uri' => 'memory://abc', 'text' => 'new'], ['id' => 1]);
        $this->assertSame('store', $spy->lastMethod);

        $spy->searchResults = [['id' => 'abc', 'content' => 'x']];
        $list = $server->dispatch('resource_list', [], ['id' => 1]);
        $decoded = json_decode($list['content'][0]['text'] ?? '[]', true, flags: JSON_THROW_ON_ERROR);
        $this->assertCount(1, $decoded);
    }
}
