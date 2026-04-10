<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\HostAuthDigestRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class HostAuthDigestRepositoryEngineTest extends TestCase
{
    private PDO $pdo;
    private HostAuthDigestRepository $repository;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec(
            'CREATE TABLE host_auth_digests (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host_id INTEGER NOT NULL,
                engine TEXT NOT NULL,
                digest TEXT NOT NULL,
                last_seen TEXT NOT NULL,
                created_at TEXT NOT NULL,
                UNIQUE (host_id, engine, digest)
            )'
        );

        $this->repository = new HostAuthDigestRepository($this->fakeDatabase($this->pdo));
    }

    public function testRememberDigestsKeepsEnginesIsolated(): void
    {
        $this->repository->rememberDigests(7, ['same-digest', 'codex-only'], 3, 'codex');
        $this->repository->rememberDigests(7, ['same-digest', 'claude-only'], 3, 'claude');

        $this->assertEqualsCanonicalizing(['same-digest', 'codex-only'], $this->repository->recentDigests(7, 3, 'codex'));
        $this->assertEqualsCanonicalizing(['same-digest', 'claude-only'], $this->repository->recentDigests(7, 3, 'claude'));
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
