<?php

declare(strict_types=1);

use App\Database;
use App\Exceptions\HttpException;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\AdminWebAuthnChallengeRepository;
use App\Repositories\LogRepository;
use App\Services\AdminPasskeyService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyServiceTest extends TestCase
{
    private PDO $pdo;
    private AdminPasskeyService $service;
    private AdminPasskeyRepository $passkeys;
    private AdminWebAuthnChallengeRepository $challenges;
    private AdminUserRepository $users;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        $this->pdo->exec(
            'CREATE TABLE admin_users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                username TEXT NOT NULL UNIQUE,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                access_level TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,
                last_login_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );
        $this->pdo->exec(
            'CREATE TABLE admin_passkeys (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                credential_id BLOB NOT NULL,
                credential_id_hash TEXT NOT NULL UNIQUE,
                public_key_pem TEXT NOT NULL,
                cose_alg INTEGER NOT NULL,
                sign_count INTEGER NOT NULL DEFAULT 0,
                name TEXT NOT NULL DEFAULT \'\',
                transports TEXT NULL,
                aaguid TEXT NULL,
                created_at TEXT NOT NULL,
                last_used_at TEXT NULL
            )'
        );
        $this->pdo->exec(
            'CREATE TABLE admin_webauthn_challenges (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                challenge TEXT NOT NULL UNIQUE,
                user_id INTEGER NULL,
                type TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $this->users = new AdminUserRepository($database);
        $this->passkeys = new AdminPasskeyRepository($database);
        $this->challenges = new AdminWebAuthnChallengeRepository($database);
        $logs = new AdminPasskeyTestLogRepository();

        $this->service = new AdminPasskeyService(
            $this->passkeys,
            $this->challenges,
            $this->users,
            $logs
        );

        $this->users->create([
            'name' => 'Admin',
            'username' => 'admin',
            'email' => 'admin@example.com',
            'password_hash' => password_hash('test', PASSWORD_DEFAULT),
            'access_level' => 'admin',
            'active' => true,
        ]);
    }

    public function testBeginRegistrationReturnsOptions(): void
    {
        $user = $this->users->findByUsername('admin');
        $options = $this->service->beginRegistration($user, 'example.com', 'Test RP');

        self::assertNotEmpty($options['challenge']);
        self::assertSame(64, strlen($options['challenge'])); // 32 bytes hex
        self::assertSame('example.com', $options['rp']['id']);
        self::assertSame('Test RP', $options['rp']['name']);
        self::assertSame('admin', $options['user']['name']);
        self::assertCount(2, $options['pubKeyCredParams']);
        self::assertSame(-7, $options['pubKeyCredParams'][0]['alg']);
        self::assertSame(-257, $options['pubKeyCredParams'][1]['alg']);
        self::assertSame('none', $options['attestation']);
        self::assertSame('platform', $options['authenticatorSelection']['authenticatorAttachment']);
        self::assertIsArray($options['excludeCredentials']);
    }

    public function testBeginRegistrationCreatesChallenge(): void
    {
        $user = $this->users->findByUsername('admin');
        $options = $this->service->beginRegistration($user, 'example.com', 'Test RP');

        // Challenge should be consumable.
        $challenge = $this->challenges->consume($options['challenge'], gmdate(DATE_ATOM));
        self::assertNotNull($challenge);
        self::assertSame('registration', $challenge['type']);
        self::assertSame((string) $user['id'], (string) $challenge['user_id']);
    }

    public function testBeginAuthenticationReturnsOptions(): void
    {
        $options = $this->service->beginAuthentication('example.com');

        self::assertNotEmpty($options['challenge']);
        self::assertSame('example.com', $options['rpId']);
        self::assertSame(300000, $options['timeout']);
        self::assertSame([], $options['allowCredentials']);
    }

    public function testBeginAuthenticationCreatesChallenge(): void
    {
        $options = $this->service->beginAuthentication('example.com');

        $challenge = $this->challenges->consume($options['challenge'], gmdate(DATE_ATOM));
        self::assertNotNull($challenge);
        self::assertSame('authentication', $challenge['type']);
        self::assertNull($challenge['user_id']);
    }

    public function testListForUserEmpty(): void
    {
        $user = $this->users->findByUsername('admin');
        $list = $this->service->listForUser((int) $user['id']);
        self::assertSame([], $list);
    }

    public function testDeletePasskeyNotFound(): void
    {
        $this->expectException(HttpException::class);
        $this->service->deletePasskey(999, 1);
    }

    public function testDeletePasskeyWrongUser(): void
    {
        // Create a passkey for user 1.
        $credId = random_bytes(32);
        $this->passkeys->create(
            1,
            $credId,
            hash('sha256', $credId),
            'dummy-pem',
            -7,
            0,
            'Test Key',
            null,
            null
        );

        $list = $this->passkeys->findAllForUser(1);
        self::assertCount(1, $list);

        $this->expectException(HttpException::class);
        $this->service->deletePasskey((int) $list[0]['id'], 999); // wrong user
    }

    public function testDeletePasskeySuccess(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(
            1,
            $credId,
            hash('sha256', $credId),
            'dummy-pem',
            -7,
            0,
            'Test Key',
            null,
            null
        );

        $list = $this->passkeys->findAllForUser(1);
        self::assertCount(1, $list);

        $this->service->deletePasskey((int) $list[0]['id'], 1);
        $list = $this->passkeys->findAllForUser(1);
        self::assertCount(0, $list);
    }

    public function testUpdatePasskeyName(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(
            1,
            $credId,
            hash('sha256', $credId),
            'dummy-pem',
            -7,
            0,
            'Old Name',
            null,
            null
        );

        $list = $this->passkeys->findAllForUser(1);
        self::assertSame('Old Name', $list[0]['name']);

        $this->service->updatePasskeyName((int) $list[0]['id'], 1, 'New Name');

        $list = $this->passkeys->findAllForUser(1);
        self::assertSame('New Name', $list[0]['name']);
    }

    public function testUpdatePasskeyNameWrongUser(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(1, $credId, hash('sha256', $credId), 'pem', -7, 0, 'X', null, null);
        $list = $this->passkeys->findAllForUser(1);

        $this->expectException(HttpException::class);
        $this->service->updatePasskeyName((int) $list[0]['id'], 999, 'Hack');
    }

    public function testChallengeExpiry(): void
    {
        // Create expired challenge.
        $expired = gmdate(DATE_ATOM, time() - 10);
        $this->challenges->create('deadbeef' . str_repeat('0', 56), null, 'authentication', $expired);

        $result = $this->challenges->consume('deadbeef' . str_repeat('0', 56), gmdate(DATE_ATOM));
        self::assertNull($result); // Expired, should not be consumable.
    }

    public function testChallengeSingleUse(): void
    {
        $expiresAt = gmdate(DATE_ATOM, time() + 300);
        $challenge = bin2hex(random_bytes(32));
        $this->challenges->create($challenge, null, 'authentication', $expiresAt);

        $first = $this->challenges->consume($challenge, gmdate(DATE_ATOM));
        self::assertNotNull($first);

        $second = $this->challenges->consume($challenge, gmdate(DATE_ATOM));
        self::assertNull($second); // Already consumed.
    }

    public function testListForUserSanitized(): void
    {
        $credId = random_bytes(32);
        $this->passkeys->create(1, $credId, hash('sha256', $credId), 'secret-pem-data', -7, 0, 'MyKey', 'internal', null);

        $list = $this->service->listForUser(1);
        self::assertCount(1, $list);
        self::assertSame('MyKey', $list[0]['name']);
        // Sanitized: no public_key_pem, no credential_id.
        self::assertArrayNotHasKey('public_key_pem', $list[0]);
        self::assertArrayNotHasKey('credential_id', $list[0]);
        self::assertArrayNotHasKey('credential_id_hash', $list[0]);
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

final class AdminPasskeyTestLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
    }
}
