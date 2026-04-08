<?php

declare(strict_types=1);

use App\Database;
use App\Security\SecretBox;
use App\Services\AuthEncryptionMigrator;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthEncryptionMigratorTest extends TestCase
{
    private \PDO $pdo;
    private Database $database;
    private SecretBox $encrypter;

    protected function setUp(): void
    {
        if (!extension_loaded('sodium')) {
            $this->markTestSkipped('sodium extension is required');
        }

        $this->pdo = new \PDO('sqlite::memory:', null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);

        $this->pdo->exec('CREATE TABLE auth_payloads (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            body TEXT
        )');
        $this->pdo->exec('CREATE TABLE auth_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL
        )');
        $this->pdo->exec('CREATE TABLE install_tokens (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT NOT NULL,
            token_enc TEXT,
            api_key TEXT NOT NULL,
            api_key_enc TEXT
        )');

        $this->database = $this->fakeDatabase($this->pdo);

        $key = sodium_crypto_secretbox_keygen();
        $this->encrypter = new SecretBox($key);
    }

    public function testMigratesPlaintextPayloads(): void
    {
        $this->pdo->exec("INSERT INTO auth_payloads (body) VALUES ('plaintext-body')");

        $migrator = new AuthEncryptionMigrator($this->database, $this->encrypter);
        $migrator->migrate();

        $row = $this->pdo->query('SELECT body FROM auth_payloads LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertTrue($this->encrypter->isEncrypted($row['body']));
        $this->assertSame('plaintext-body', $this->encrypter->decrypt($row['body']));
    }

    public function testSkipsAlreadyEncryptedPayloads(): void
    {
        $encrypted = $this->encrypter->encrypt('already-encrypted');
        $stmt = $this->pdo->prepare("INSERT INTO auth_payloads (body) VALUES (:body)");
        $stmt->execute(['body' => $encrypted]);

        $migrator = new AuthEncryptionMigrator($this->database, $this->encrypter);
        $migrator->migrate();

        $row = $this->pdo->query('SELECT body FROM auth_payloads LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame($encrypted, $row['body']);
    }

    public function testMigratesPlaintextEntryTokens(): void
    {
        $this->pdo->exec("INSERT INTO auth_entries (token) VALUES ('plain-token')");

        $migrator = new AuthEncryptionMigrator($this->database, $this->encrypter);
        $migrator->migrate();

        $row = $this->pdo->query('SELECT token FROM auth_entries LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertTrue($this->encrypter->isEncrypted($row['token']));
        $this->assertSame('plain-token', $this->encrypter->decrypt($row['token']));
    }

    public function testMigratesInstallerTokens(): void
    {
        // Short token triggers migration (LENGTH(token) < 64)
        $this->pdo->exec("INSERT INTO install_tokens (token, api_key) VALUES ('short-token', 'my-api-key')");

        $migrator = new AuthEncryptionMigrator($this->database, $this->encrypter);
        $migrator->migrate();

        $row = $this->pdo->query('SELECT token, token_enc, api_key, api_key_enc FROM install_tokens LIMIT 1')->fetch(\PDO::FETCH_ASSOC);
        $this->assertSame(hash('sha256', 'short-token'), $row['token']);
        $this->assertTrue($this->encrypter->isEncrypted($row['token_enc']));
        $this->assertSame('short-token', $this->encrypter->decrypt($row['token_enc']));
        $this->assertTrue($this->encrypter->isEncrypted($row['api_key_enc']));
        $this->assertSame('my-api-key', $this->encrypter->decrypt($row['api_key_enc']));
    }

    public function testNoOpWhenNothingToMigrate(): void
    {
        $migrator = new AuthEncryptionMigrator($this->database, $this->encrypter);
        $migrator->migrate();
        // Should not throw
        $this->assertTrue(true);
    }

    private function fakeDatabase(\PDO $pdo): Database
    {
        $ref = new \ReflectionClass(Database::class);
        $db = $ref->newInstanceWithoutConstructor();

        $pdoProp = $ref->getProperty('pdo');
        $pdoProp->setValue($db, $pdo);

        $dbNameProp = $ref->getProperty('databaseName');
        $dbNameProp->setValue($db, 'test');

        return $db;
    }
}
