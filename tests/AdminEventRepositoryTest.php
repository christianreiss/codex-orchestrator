<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\AdminEventRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminEventRepositoryTest extends TestCase
{
    private \PDO $pdo;
    private AdminEventRepository $repository;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:', null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);

        $this->pdo->exec('CREATE TABLE admin_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            host_id INTEGER,
            payload TEXT,
            created_at TEXT NOT NULL
        )');

        $this->repository = new AdminEventRepository($this->fakeDatabase($this->pdo));
    }

    public function testAppendCreatesEvent(): void
    {
        $event = $this->repository->append('host.registered', ['fqdn' => 'test.local'], 1);

        $this->assertSame(1, $event['id']);
        $this->assertSame('host.registered', $event['type']);
        $this->assertSame(1, $event['host_id']);
        $this->assertSame(['fqdn' => 'test.local'], $event['payload']);
        $this->assertNotNull($event['created_at']);
    }

    public function testAppendDefaultsEmptyTypeToEvent(): void
    {
        $event = $this->repository->append('');
        $this->assertSame('event', $event['type']);
    }

    public function testLatestIdReturnsZeroWhenEmpty(): void
    {
        $this->assertSame(0, $this->repository->latestId());
    }

    public function testLatestIdReturnsHighestId(): void
    {
        $this->repository->append('a');
        $this->repository->append('b');
        $this->repository->append('c');

        $this->assertSame(3, $this->repository->latestId());
    }

    public function testSinceIdReturnsEventsAfterGivenId(): void
    {
        $this->repository->append('a');
        $this->repository->append('b');
        $this->repository->append('c');

        $events = $this->repository->sinceId(1);
        $this->assertCount(2, $events);
        $this->assertSame('b', $events[0]['type']);
        $this->assertSame('c', $events[1]['type']);
    }

    public function testSinceIdRespectsLimit(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->repository->append("event-$i");
        }

        $events = $this->repository->sinceId(0, 2);
        $this->assertCount(2, $events);
    }

    public function testRecentReturnsEventsInAscOrder(): void
    {
        $this->repository->append('first');
        $this->repository->append('second');
        $this->repository->append('third');

        $events = $this->repository->recent(3);
        $this->assertCount(3, $events);
        $this->assertSame('first', $events[0]['type']);
        $this->assertSame('third', $events[2]['type']);
    }

    public function testRecentRespectsLimit(): void
    {
        for ($i = 0; $i < 10; $i++) {
            $this->repository->append("event-$i");
        }

        $events = $this->repository->recent(3);
        $this->assertCount(3, $events);
    }

    public function testPayloadJsonRoundTrip(): void
    {
        $payload = ['action' => 'delete', 'count' => 5];
        $this->repository->append('test', $payload);

        $events = $this->repository->recent(1);
        $this->assertSame($payload, $events[0]['payload']);
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
