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
        if (!defined('SODIUM_CRYPTO_SECRETBOX_KEYBYTES')) {
            define('SODIUM_CRYPTO_SECRETBOX_KEYBYTES', 32);
        }
        if (!extension_loaded('sodium')) {
            $this->markTestSkipped('sodium extension is required for SecretBox tests');
        }
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
                insecure_window_minutes INTEGER NULL,
                last_refresh TEXT NULL,
                claude_last_refresh TEXT NULL,
                auth_digest TEXT NULL,
                claude_auth_digest TEXT NULL,
                ip4 TEXT NULL,
                ip6 TEXT NULL,
                client_version TEXT NULL,
                claude_client_version TEXT NULL,
                wrapper_version TEXT NULL,
                claude_wrapper_version TEXT NULL,
                api_calls INTEGER DEFAULT 0,
                expires_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $this->pdo->exec(
            'CREATE TABLE host_auth_states (
                host_id INTEGER NOT NULL,
                payload_id INTEGER NOT NULL,
                engine TEXT NOT NULL DEFAULT "codex",
                seen_digest TEXT NOT NULL,
                seen_at TEXT NOT NULL,
                PRIMARY KEY (host_id, engine)
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('k', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->repository = new HostRepository($database, $secretBox);

        $now = gmdate(DATE_ATOM);
        $seedHost = $this->pdo->prepare(
            'INSERT INTO hosts (fqdn, api_key, status, secure, allow_roaming_ips, last_refresh, claude_last_refresh, auth_digest, claude_auth_digest, ip4, client_version, claude_client_version, wrapper_version, claude_wrapper_version, api_calls, created_at, updated_at)
             VALUES (:fqdn, :api_key, :status, :secure, :allow_roaming_ips, :last_refresh, :claude_last_refresh, :auth_digest, :claude_auth_digest, :ip4, :client_version, :claude_client_version, :wrapper_version, :claude_wrapper_version, :api_calls, :created_at, :updated_at)'
        );
        $seedHost->execute([
            'fqdn' => 'host.test',
            'api_key' => str_repeat('a', 64),
            'status' => 'active',
            'secure' => 1,
            'allow_roaming_ips' => 0,
            'last_refresh' => '2024-01-01T00:00:00Z',
            'claude_last_refresh' => '2024-02-01T00:00:00Z',
            'auth_digest' => str_repeat('b', 64),
            'claude_auth_digest' => str_repeat('d', 64),
            'ip4' => '127.0.0.1',
            'client_version' => '0.0.0',
            'claude_client_version' => '1.2.3',
            'wrapper_version' => null,
            'claude_wrapper_version' => '2026.04.10-01',
            'api_calls' => 5,
            'created_at' => $now,
            'updated_at' => $now,
        ]);
        $this->hostId = (int) $this->pdo->lastInsertId();

        $seedState = $this->pdo->prepare(
            'INSERT INTO host_auth_states (host_id, payload_id, engine, seen_digest, seen_at) VALUES (:host_id, :payload_id, :engine, :seen_digest, :seen_at)'
        );
        $seedState->execute([
            'host_id' => $this->hostId,
            'payload_id' => 99,
            'engine' => 'codex',
            'seen_digest' => str_repeat('c', 64),
            'seen_at' => '2024-01-01T00:00:00Z',
        ]);
        $seedState->execute([
            'host_id' => $this->hostId,
            'payload_id' => 100,
            'engine' => 'claude',
            'seen_digest' => str_repeat('e', 64),
            'seen_at' => '2024-02-01T00:00:00Z',
        ]);
    }

    public function testClearHostAuthResetsCanonicalPointers(): void
    {
        $hostBefore = $this->repository->findById($this->hostId);
        $this->assertNotNull($hostBefore);
        $this->assertSame('2024-01-01T00:00:00Z', $hostBefore['last_refresh']);
        $this->assertSame('2024-02-01T00:00:00Z', $hostBefore['claude_last_refresh']);
        $this->assertSame(str_repeat('b', 64), $hostBefore['auth_digest']);
        $this->assertSame(str_repeat('d', 64), $hostBefore['claude_auth_digest']);
        $this->assertSame(2, $this->stateCount());

        $this->repository->clearHostAuth($this->hostId);

        $hostAfter = $this->repository->findById($this->hostId);
        $this->assertNotNull($hostAfter);
        $this->assertNull($hostAfter['last_refresh']);
        $this->assertNull($hostAfter['claude_last_refresh']);
        $this->assertNull($hostAfter['auth_digest']);
        $this->assertNull($hostAfter['claude_auth_digest']);
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
