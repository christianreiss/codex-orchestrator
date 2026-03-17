<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\McpAccessLogRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class McpAccessLogRepositoryTest extends TestCase
{
    private \PDO $pdo;
    private McpAccessLogRepository $repository;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:', null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);

        $this->pdo->exec('CREATE TABLE hosts (
            id INTEGER PRIMARY KEY,
            fqdn TEXT
        )');
        $this->pdo->exec('CREATE TABLE mcp_access_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_id INTEGER,
            client_ip TEXT,
            method TEXT NOT NULL,
            name TEXT,
            success INTEGER NOT NULL,
            error_code INTEGER,
            error_message TEXT,
            created_at TEXT NOT NULL
        )');
        $this->pdo->exec("INSERT INTO hosts (id, fqdn) VALUES (1, 'test.local')");

        $this->repository = new McpAccessLogRepository($this->fakeDatabase($this->pdo));
    }

    public function testLogInsertsRecord(): void
    {
        $this->repository->log(1, '10.0.0.1', 'tools/call', 'memory_store', true, null, null);

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM mcp_access_logs')->fetchColumn();
        $this->assertSame(1, $count);
    }

    public function testLogStoresErrorInfo(): void
    {
        $this->repository->log(1, '10.0.0.2', 'tools/call', 'bad_tool', false, -32601, 'Tool not found');

        $row = $this->pdo->query('SELECT * FROM mcp_access_logs LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame(0, (int) $row['success']);
        $this->assertSame(-32601, (int) $row['error_code']);
        $this->assertSame('Tool not found', $row['error_message']);
    }

    public function testRecentReturnsDescendingOrder(): void
    {
        $this->repository->log(1, '10.0.0.1', 'tools/call', 'first', true, null, null);
        $this->repository->log(1, '10.0.0.1', 'tools/call', 'second', true, null, null);
        $this->repository->log(1, '10.0.0.1', 'tools/call', 'third', true, null, null);

        $recent = $this->repository->recent(3);
        $this->assertCount(3, $recent);
        $this->assertSame('third', $recent[0]['name']);
        $this->assertSame('first', $recent[2]['name']);
    }

    public function testRecentJoinsHostFqdn(): void
    {
        $this->repository->log(1, '10.0.0.1', 'tools/call', 'test', true, null, null);

        $recent = $this->repository->recent(1);
        $this->assertSame('test.local', $recent[0]['host_fqdn']);
    }

    public function testRecentRespectsLimit(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->repository->log(1, '10.0.0.1', 'tools/call', "tool-$i", true, null, null);
        }

        $recent = $this->repository->recent(3);
        $this->assertCount(3, $recent);
    }

    public function testLogWithNullHostId(): void
    {
        $this->repository->log(null, '10.0.0.1', 'tools/call', 'anon', true, null, null);

        $row = $this->pdo->query('SELECT * FROM mcp_access_logs LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertNull($row['host_id']);
    }

    private function fakeDatabase(\PDO $pdo): Database
    {
        $ref = new \ReflectionClass(Database::class);
        $db = $ref->newInstanceWithoutConstructor();
        $ref->getProperty('pdo')->setValue($db, $pdo);
        $ref->getProperty('databaseName')->setValue($db, 'test');
        return $db;
    }
}
