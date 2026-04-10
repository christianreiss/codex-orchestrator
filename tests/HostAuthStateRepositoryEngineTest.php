<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\HostAuthStateRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class HostAuthStateRepositoryEngineTest extends TestCase
{
    private PDO $pdo;
    private HostAuthStateRepository $repository;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec(
            'CREATE TABLE host_auth_states (
                host_id INTEGER NOT NULL,
                payload_id INTEGER NOT NULL,
                engine TEXT NOT NULL,
                seen_digest TEXT NOT NULL,
                seen_at TEXT NOT NULL,
                PRIMARY KEY (host_id, engine)
            )'
        );

        $this->repository = new HostAuthStateRepository($this->fakeDatabase($this->pdo));
    }

    public function testUpsertStoresSeparateRowsPerEngine(): void
    {
        $this->repository->upsert(7, 101, 'digest-codex', 'codex');
        $this->repository->upsert(7, 202, 'digest-claude', 'claude');

        $codex = $this->repository->findByHostId(7, 'codex');
        $claude = $this->repository->findByHostId(7, 'claude');

        $this->assertSame(101, (int) ($codex['payload_id'] ?? 0));
        $this->assertSame('digest-codex', $codex['seen_digest'] ?? null);
        $this->assertSame(202, (int) ($claude['payload_id'] ?? 0));
        $this->assertSame('digest-claude', $claude['seen_digest'] ?? null);
    }

    private function fakeDatabase(PDO $pdo): Database
    {
        $reflection = new ReflectionClass(Database::class);
        /** @var Database $database */
        $database = $reflection->newInstanceWithoutConstructor();

        $pdoProperty = $reflection->getProperty('pdo');
        $pdoProperty->setAccessible(true);
        $pdoProperty->setValue($database, $pdo);

        $nameProperty = $reflection->getProperty('databaseName');
        $nameProperty->setAccessible(true);
        $nameProperty->setValue($database, 'sqlite');

        return $database;
    }
}
