<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\HostRepository;
use App\Security\SecretBox;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class HostRepositoryClearHostAuthTest extends TestCase
{
    private PDO $pdo;
    private HostRepository $repository;
    private int $hostId;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        $this->pdo->exec(
            'CREATE TABLE hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                fqdn TEXT NOT NULL,
                api_key TEXT NOT NULL,
                status TEXT,
                secure INTEGER DEFAULT 1,
                allow_roaming_ips INTEGER DEFAULT 0,
                insecure_enabled_until TEXT NULL,
                insecure_grace_until TEXT NULL,
                last_refresh TEXT NULL,
                auth_digest TEXT NULL,
                ip TEXT NULL,
                client_version TEXT NULL,
                wrapper_version TEXT NULL,
                api_calls INTEGER DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $this->pdo->exec(
            'CREATE TABLE host_auth_states (
                host_id INTEGER NOT NULL,
                payload_id INTEGER NOT NULL,
                seen_digest TEXT NOT NULL,
                seen_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('k', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->repository = new HostRepository($database, $secretBox);

        $now = gmdate(DATE_ATOM);
        $seedHost = $this->pdo->prepare(
            'INSERT INTO hosts (fqdn, api_key, status, secure, allow_roaming_ips, last_refresh, auth_digest, ip, client_version, wrapper_version, api_calls, created_at, updated_at)
             VALUES (:fqdn, :api_key, :status, :secure, :allow_roaming_ips, :last_refresh, :auth_digest, :ip, :client_version, :wrapper_version, :api_calls, :created_at, :updated_at)'
        );
        $seedHost->execute([
            'fqdn' => 'host.test',
            'api_key' => str_repeat('a', 64),
            'status' => 'active',
            'secure' => 1,
            'allow_roaming_ips' => 0,
            'last_refresh' => '2024-01-01T00:00:00Z',
            'auth_digest' => str_repeat('b', 64),
            'ip' => '127.0.0.1',
            'client_version' => '0.0.0',
            'wrapper_version' => null,
            'api_calls' => 5,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        $this->hostId = (int) $this->pdo->lastInsertId();

        $seedState = $this->pdo->prepare(
            'INSERT INTO host_auth_states (host_id, payload_id, seen_digest, seen_at) VALUES (:host_id, :payload_id, :seen_digest, :seen_at)'
        );
        $seedState->execute([
            'host_id' => $this->hostId,
            'payload_id' => 99,
            'seen_digest' => str_repeat('c', 64),
            'seen_at' => '2024-01-01T00:00:00Z',
        ]);
    }

    public function testClearHostAuthResetsCanonicalPointers(): void
    {
        $hostBefore = $this->repository->findById($this->hostId);
        $this->assertNotNull($hostBefore);
        $this->assertSame('2024-01-01T00:00:00Z', $hostBefore['last_refresh']);
        $this->assertSame(str_repeat('b', 64), $hostBefore['auth_digest']);
        $this->assertSame(1, $this->stateCount());

        $this->repository->clearHostAuth($this->hostId);

        $hostAfter = $this->repository->findById($this->hostId);
        $this->assertNotNull($hostAfter);
        $this->assertNull($hostAfter['last_refresh']);
        $this->assertNull($hostAfter['auth_digest']);
        $this->assertSame(0, $this->stateCount());
    }

    private function stateCount(): int
    {
        $statement = $this->pdo->prepare('SELECT COUNT(*) FROM host_auth_states WHERE host_id = :host_id');
        $statement->execute(['host_id' => $this->hostId]);

        return (int) $statement->fetchColumn();
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
