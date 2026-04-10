<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\InstallTokenRepository;
use App\Security\SecretBox;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InstallTokenRepositoryTest extends TestCase
{
    private PDO $pdo;
    private InstallTokenRepository $repository;

    protected function setUp(): void
    {
        if (!defined('SODIUM_CRYPTO_SECRETBOX_KEYBYTES')) {
            define('SODIUM_CRYPTO_SECRETBOX_KEYBYTES', 32);
        }
        if (!extension_loaded('sodium')) {
            $this->markTestSkipped('sodium extension is required for InstallTokenRepository tests');
        }

        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->pdo->exec(
            'CREATE TABLE install_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL,
                token_enc TEXT NULL,
                host_id INTEGER NOT NULL,
                api_key TEXT NOT NULL,
                api_key_enc TEXT NULL,
                fqdn TEXT NOT NULL,
                base_url TEXT NULL,
                engine TEXT NOT NULL DEFAULT "codex",
                expires_at TEXT NOT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('k', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->repository = new InstallTokenRepository($database, $secretBox);
    }

    public function testCreatePersistsInstallerMode(): void
    {
        $row = $this->repository->create(
            'token-1',
            7,
            'api-key-1',
            'host.test',
            '2026-04-10T12:00:00Z',
            'https://example.test',
            'both'
        );

        $this->assertIsArray($row);
        $this->assertSame('both', $row['engine'] ?? null);
        $this->assertSame('token-1', $row['token'] ?? null);
        $this->assertSame('api-key-1', $row['api_key'] ?? null);
    }

    public function testCreateReplacesExistingPendingTokenForHost(): void
    {
        $this->repository->create('token-1', 7, 'api-key-1', 'host.test', '2026-04-10T12:00:00Z', null, 'codex');
        $this->repository->create('token-2', 7, 'api-key-2', 'host.test', '2026-04-10T12:10:00Z', null, 'claude');

        $count = (int) $this->pdo->query('SELECT COUNT(*) FROM install_tokens')->fetchColumn();
        $row = $this->repository->findByToken('token-2');

        $this->assertSame(1, $count);
        $this->assertIsArray($row);
        $this->assertSame('claude', $row['engine'] ?? null);
        $this->assertSame('api-key-2', $row['api_key'] ?? null);
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
