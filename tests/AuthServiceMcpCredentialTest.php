<?php

declare(strict_types=1);

use App\Database;
use App\Exceptions\HttpException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\LogRepository;
use App\Repositories\McpSessionTokenRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Security\SecretBox;
use App\Services\AuthService;
use App\Services\PricingService;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthServiceMcpCredentialTest extends TestCase
{
    private PDO $pdo;
    private HostRepository $hosts;
    private McpSessionTokenRepository $tokens;
    private AuthService $service;

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
                fqdn TEXT NOT NULL UNIQUE,
                api_key TEXT NOT NULL,
                api_key_hash TEXT NULL,
                api_key_enc TEXT NULL,
                status TEXT NOT NULL DEFAULT "active",
                secure INTEGER NOT NULL DEFAULT 1,
                vip INTEGER NOT NULL DEFAULT 0,
                model_override TEXT NULL,
                reasoning_effort_override TEXT NULL,
                allow_roaming_ips INTEGER NOT NULL DEFAULT 0,
                reverse_dns_mode INTEGER NULL,
                insecure_enabled_until TEXT NULL,
                insecure_grace_until TEXT NULL,
                insecure_window_minutes INTEGER NULL,
                last_refresh TEXT NULL,
                auth_digest TEXT NULL,
                ip4 TEXT NULL,
                ip6 TEXT NULL,
                client_version TEXT NULL,
                client_version_override TEXT NULL,
                wrapper_version TEXT NULL,
                api_calls INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NULL,
                lane_preference TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $this->pdo->exec(
            'CREATE TABLE mcp_session_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                token TEXT NOT NULL UNIQUE,
                token_enc TEXT NULL,
                host_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                last_used_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('x', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->hosts = new HostRepository($database, $secretBox);
        $this->tokens = new McpSessionTokenRepository($database, $secretBox);

        $this->service = new AuthService(
            $this->hosts,
            $this->createMock(AuthPayloadRepository::class),
            $this->createMock(HostAuthStateRepository::class),
            $this->createMock(HostAuthDigestRepository::class),
            $this->createMock(HostUserRepository::class),
            new AuthServiceMcpCredentialLogRepository(),
            $this->createMock(TokenUsageRepository::class),
            $this->createMock(TokenUsageIngestRepository::class),
            $this->createMock(PricingService::class),
            $this->createMock(VersionRepository::class),
            $this->createMock(WrapperService::class),
            null,
            null,
            null,
            null,
            null,
            null,
            $this->tokens
        );
    }

    public function testAuthenticateMcpCredentialAcceptsValidEphemeralToken(): void
    {
        $host = $this->hosts->create(bin2hex(random_bytes(6)) . '.test', bin2hex(random_bytes(32)), false);
        $token = 'mcp_' . bin2hex(random_bytes(24));
        $expiresAt = gmdate(DATE_ATOM, time() + 900);
        $this->tokens->create($token, (int) $host['id'], $expiresAt);

        $resolved = $this->service->authenticateMcpCredential($token, '203.0.113.7');

        self::assertSame((int) $host['id'], (int) $resolved['id']);
        self::assertSame($host['fqdn'], $resolved['fqdn']);
    }

    public function testAuthenticateMcpCredentialRejectsExpiredToken(): void
    {
        $host = $this->hosts->create(bin2hex(random_bytes(6)) . '.test', bin2hex(random_bytes(32)), false);
        $token = 'mcp_' . bin2hex(random_bytes(24));
        $expiresAt = gmdate(DATE_ATOM, time() - 60);
        $this->tokens->create($token, (int) $host['id'], $expiresAt);

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('MCP credential invalid');

        $this->service->authenticateMcpCredential($token, '203.0.113.7');
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

final class AuthServiceMcpCredentialLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        // no-op
    }
}
