<?php

declare(strict_types=1);

use App\Database;
use App\Exceptions\ValidationException;
use App\Repositories\AdminPasswordResetRepository;
use App\Repositories\AdminSessionRepository;
use App\Repositories\AdminUserRepository;
use App\Repositories\LogRepository;
use App\Services\AdminAuthService;
use App\Services\AdminUserService;
use App\Support\Mailer;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUserServiceBootstrapTest extends TestCase
{
    private PDO $pdo;
    private AdminUserService $service;

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

        $database = $this->fakeDatabase($this->pdo);
        $users = new AdminUserRepository($database);
        $sessions = new AdminSessionRepository($database);
        $resets = new AdminPasswordResetRepository($database);
        $logs = new AdminUserServiceLogRepository();
        $auth = new AdminAuthService($users, $sessions, $resets, $logs, new Mailer());

        $this->service = new AdminUserService($users, $sessions, $resets, $logs, $auth);
    }

    public function testFirstUserMustBeAdmin(): void
    {
        $this->expectException(ValidationException::class);
        $this->service->createUser([
            'name' => 'User',
            'username' => 'user1',
            'email' => 'user1@example.com',
            'access_level' => 'user',
            'password' => 'passwordpassword',
        ]);
    }

    public function testCreateFirstAdmin(): void
    {
        $user = $this->service->createUser([
            'name' => 'Admin',
            'username' => 'admin',
            'email' => 'admin@example.com',
            'access_level' => 'admin',
            'password' => 'passwordpassword',
        ]);

        self::assertSame('admin', $user['access_level']);
        self::assertTrue($user['active']);
    }

    public function testCannotDemoteLastAdmin(): void
    {
        $user = $this->service->createUser([
            'name' => 'Admin',
            'username' => 'admin',
            'email' => 'admin@example.com',
            'access_level' => 'admin',
            'password' => 'passwordpassword',
        ]);

        $this->expectException(ValidationException::class);
        $this->service->updateUser((int) $user['id'], [
            'access_level' => 'user',
        ]);
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

final class AdminUserServiceLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
    }
}
