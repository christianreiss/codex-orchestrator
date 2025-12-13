<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\HostRepository;
use App\Security\SecretBox;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class HostRepositoryModelOverridesTest extends TestCase
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
                model_override TEXT NULL,
                reasoning_effort_override TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('k', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->repository = new HostRepository($database, $secretBox);

        $seed = $this->pdo->prepare(
            'INSERT INTO hosts (fqdn, api_key, status, secure, allow_roaming_ips, model_override, reasoning_effort_override, created_at, updated_at)
             VALUES (:fqdn, :api_key, :status, :secure, :allow_roaming_ips, :model_override, :reasoning_effort_override, :created_at, :updated_at)'
        );
        $seed->execute([
            'fqdn' => 'host.test',
            'api_key' => str_repeat('a', 64),
            'status' => 'active',
            'secure' => 1,
            'allow_roaming_ips' => 0,
            'model_override' => null,
            'reasoning_effort_override' => null,
            'created_at' => '2024-01-01T00:00:00Z',
            'updated_at' => '2024-01-01T00:00:00Z',
        ]);
        $this->hostId = (int) $this->pdo->lastInsertId();
    }

    public function testUpdateModelOverridesPersistsValues(): void
    {
        $this->repository->updateModelOverrides($this->hostId, 'gpt-5.2', 'high');

        $host = $this->repository->findById($this->hostId);
        $this->assertNotNull($host);
        $this->assertSame('gpt-5.2', $host['model_override']);
        $this->assertSame('high', $host['reasoning_effort_override']);
        $this->assertNotSame('2024-01-01T00:00:00Z', $host['updated_at']);
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

