<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\InsecureAuthRequestRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InsecureAuthRequestRepositoryTest extends TestCase
{
    private \PDO $pdo;
    private InsecureAuthRequestRepository $repository;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:', null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);

        $this->pdo->exec('CREATE TABLE insecure_auth_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            host_id INTEGER NOT NULL,
            status TEXT NOT NULL,
            request_ip TEXT,
            requested_at TEXT,
            resolved_at TEXT,
            updated_at TEXT
        )');

        $this->repository = new InsecureAuthRequestRepository($this->fakeDatabase($this->pdo));
    }

    public function testCreateReturnsPendingRequest(): void
    {
        $request = $this->repository->create(1, '10.0.0.1');

        $this->assertSame(1, $request['id']);
        $this->assertSame(1, $request['host_id']);
        $this->assertSame('pending', $request['status']);
        $this->assertSame('10.0.0.1', $request['request_ip']);
        $this->assertNull($request['resolved_at']);
    }

    public function testFindPendingByHost(): void
    {
        $this->repository->create(1, '10.0.0.1');
        $result = $this->repository->findPendingByHost(1);

        $this->assertNotNull($result);
        $this->assertSame('pending', $result['status']);
    }

    public function testFindPendingByHostReturnsNullWhenNone(): void
    {
        $this->assertNull($this->repository->findPendingByHost(999));
    }

    public function testFindPendingByHostIgnoresResolved(): void
    {
        $request = $this->repository->create(1);
        $this->repository->markApproved($request['id']);

        $this->assertNull($this->repository->findPendingByHost(1));
    }

    public function testFindLatestByHost(): void
    {
        $this->repository->create(1);
        $this->repository->create(1);

        $result = $this->repository->findLatestByHost(1);
        $this->assertNotNull($result);
        $this->assertSame(2, $result['id']);
    }

    public function testFindById(): void
    {
        $created = $this->repository->create(1);
        $found = $this->repository->findById($created['id']);

        $this->assertNotNull($found);
        $this->assertSame($created['id'], $found['id']);
    }

    public function testFindByIdReturnsNullForMissing(): void
    {
        $this->assertNull($this->repository->findById(999));
    }

    public function testMarkApproved(): void
    {
        $request = $this->repository->create(1);
        $this->repository->markApproved($request['id']);

        $found = $this->repository->findById($request['id']);
        $this->assertSame('approved', $found['status']);
        $this->assertNotNull($found['resolved_at']);
    }

    public function testMarkDenied(): void
    {
        $request = $this->repository->create(1);
        $this->repository->markDenied($request['id']);

        $found = $this->repository->findById($request['id']);
        $this->assertSame('denied', $found['status']);
        $this->assertNotNull($found['resolved_at']);
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
