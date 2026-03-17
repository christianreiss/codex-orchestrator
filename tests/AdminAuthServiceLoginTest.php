<?php

declare(strict_types=1);

use App\Database;
use App\Exceptions\HttpException;
use App\Repositories\AdminPasskeyRepository;
use App\Repositories\AdminPasswordResetRepository;
use App\Repositories\AdminSessionRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\LogRepository;
use App\Services\AdminAuthService;
use App\Support\Mailer;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAuthServiceLoginTest extends TestCase
{
    private PDO $pdo;
    private AdminAuthService $service;
    private AdminUserRepository $users;
    private AdminPasskeyRepository $passkeys;

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
            'CREATE TABLE admin_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                ip TEXT NULL,
                user_agent TEXT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )'
        );
        $this->pdo->exec(
            'CREATE TABLE admin_password_resets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL
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

        $database = $this->fakeDatabase($this->pdo);
        $this->users = new AdminUserRepository($database);
        $this->passkeys = new AdminPasskeyRepository($database);
        $sessions = new AdminSessionRepository($database);
        $resets = new AdminPasswordResetRepository($database);
        $logs = new AdminAuthServiceLogRepository();

        $this->service = new AdminAuthService($this->users, $sessions, $resets, $logs, new Mailer(), $this->passkeys);

        $this->users->create([
            'name' => 'Admin',
            'username' => 'admin',
            'email' => 'admin@example.com',
            'password_hash' => password_hash('passwordpassword', PASSWORD_DEFAULT),
            'access_level' => 'admin',
            'active' => true,
        ]);
    }

    public function testLoginIssuesSession(): void
    {
        $result = $this->service->login('admin', 'passwordpassword', null, null);
        self::assertNotEmpty($result['token']);
        self::assertSame('admin', $result['user']['username']);

        $session = $this->service->resolveSession($result['token']);
        self::assertNotNull($session);
        self::assertSame('admin', $session['user']['username']);
    }

    public function testLoginRejectsBadPassword(): void
    {
        $this->expectException(HttpException::class);
        $this->service->login('admin', 'wrong', null, null);
    }

    public function testResolveLoginMethodReturnsPasswordWhenNoPasskeyExists(): void
    {
        self::assertSame('password', $this->service->resolveLoginMethod('admin'));
    }

    public function testResolveLoginMethodReturnsPasskeyWhenUserHasPasskeys(): void
    {
        $this->registerPasskeyForUser(1);
        self::assertSame('passkey', $this->service->resolveLoginMethod('admin'));
    }

    public function testResolveLoginMethodRejectsUnknownUser(): void
    {
        try {
            $this->service->resolveLoginMethod('ghost');
            self::fail('Expected login method lookup to reject unknown user.');
        } catch (HttpException $exception) {
            self::assertSame(401, $exception->getStatusCode());
            self::assertSame('Invalid credentials', $exception->getMessage());
        }
    }

    public function testLoginRejectsPasswordWhenUserHasPasskey(): void
    {
        $this->registerPasskeyForUser(1);

        try {
            $this->service->login('admin', 'passwordpassword', null, null);
            self::fail('Expected password login to be rejected for passkey-enabled users.');
        } catch (HttpException $exception) {
            self::assertSame(403, $exception->getStatusCode());
            self::assertSame('Passkey login required for this user', $exception->getMessage());
        }
    }

    public function testCapabilityRequiresSessionWhenEnforced(): void
    {
        $this->expectException(HttpException::class);
        $this->service->enforceCapability(null, AdminAuthService::CAP_SETTINGS);
    }

    public function testCapabilityBypassesWhenNoAdmins(): void
    {
        $emptyPdo = new PDO('sqlite::memory:');
        $emptyPdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $emptyPdo->exec(
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
        $emptyPdo->exec(
            'CREATE TABLE admin_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                ip TEXT NULL,
                user_agent TEXT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )'
        );
        $emptyPdo->exec(
            'CREATE TABLE admin_password_resets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($emptyPdo);
        $users = new AdminUserRepository($database);
        $sessions = new AdminSessionRepository($database);
        $resets = new AdminPasswordResetRepository($database);
        $logs = new AdminAuthServiceLogRepository();

        $service = new AdminAuthService($users, $sessions, $resets, $logs, new Mailer());
        self::assertFalse($service->isEnforced());
        $service->enforceCapability(null, AdminAuthService::CAP_SETTINGS);
        $this->assertTrue(true);
    }

    public function testUserlessModeAllowsAdminWrites(): void
    {
        $emptyPdo = new PDO('sqlite::memory:');
        $emptyPdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $emptyPdo->exec(
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
        $emptyPdo->exec(
            'CREATE TABLE admin_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                ip TEXT NULL,
                user_agent TEXT NULL,
                created_at TEXT NOT NULL,
                last_seen_at TEXT NOT NULL,
                expires_at TEXT NOT NULL
            )'
        );
        $emptyPdo->exec(
            'CREATE TABLE admin_password_resets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                token_hash TEXT NOT NULL UNIQUE,
                expires_at TEXT NOT NULL,
                used_at TEXT NULL,
                created_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($emptyPdo);
        $users = new AdminUserRepository($database);
        $sessions = new AdminSessionRepository($database);
        $resets = new AdminPasswordResetRepository($database);
        $logs = new AdminAuthServiceLogRepository();

        $service = new AdminAuthService($users, $sessions, $resets, $logs, new Mailer());
        self::assertFalse($service->isEnforced());
        $service->enforceCapability(null, AdminAuthService::CAP_SETTINGS);
        $this->assertTrue(true);
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

    private function registerPasskeyForUser(int $userId): void
    {
        $credentialId = random_bytes(32);
        $this->passkeys->create(
            $userId,
            $credentialId,
            hash('sha256', $credentialId),
            'dummy-pem',
            -7,
            0,
            'Test Key',
            'internal',
            null
        );
    }
}

final class AdminAuthServiceLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
    }
}
