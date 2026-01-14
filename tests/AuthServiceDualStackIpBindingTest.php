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
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Security\SecretBox;
use App\Services\AuthService;
use App\Services\PricingService;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthServiceDualStackIpBindingTest extends TestCase
{
    private PDO $pdo;
    private HostRepository $hosts;
    private DualStackLogRepository $logs;
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
                insecure_enabled_until TEXT NULL,
                insecure_grace_until TEXT NULL,
                insecure_window_minutes INTEGER NULL,
                last_refresh TEXT NULL,
                auth_digest TEXT NULL,
                ip TEXT NULL,
                ip_alt TEXT NULL,
                client_version TEXT NULL,
                client_version_override TEXT NULL,
                wrapper_version TEXT NULL,
                api_calls INTEGER NOT NULL DEFAULT 0,
                force_ipv4 INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('x', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->hosts = new HostRepository($database, $secretBox);
        $this->logs = new DualStackLogRepository();

        $this->service = new AuthService(
            $this->hosts,
            $this->createMock(AuthPayloadRepository::class),
            $this->createMock(HostAuthStateRepository::class),
            $this->createMock(HostAuthDigestRepository::class),
            $this->createMock(HostUserRepository::class),
            $this->logs,
            $this->createMock(TokenUsageRepository::class),
            $this->createMock(TokenUsageIngestRepository::class),
            $this->createMock(PricingService::class),
            $this->createMock(VersionRepository::class),
            $this->createMock(WrapperService::class),
            null,
        );
    }

    public function testSecureHostBindsSecondaryIpForDualStack(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create('dualstack.test', $apiKey, true);

        $this->service->authenticate($apiKey, '203.0.113.10');
        $this->service->authenticate($apiKey, '2001:db8::1');

        $reloaded = $this->hosts->findById((int) $host['id']);
        self::assertSame('203.0.113.10', $reloaded['ip']);
        self::assertSame('2001:db8::1', $reloaded['ip_alt']);
        self::assertLogContains('auth.bind_ip_secondary');
    }

    public function testIpv4MappedIpv6MatchesStoredIpv4(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create('mapped.test', $apiKey, true);

        $this->service->authenticate($apiKey, '203.0.113.42');
        $this->service->authenticate($apiKey, '::ffff:203.0.113.42');

        $reloaded = $this->hosts->findById((int) $host['id']);
        self::assertSame('203.0.113.42', $reloaded['ip']);
        self::assertNull($reloaded['ip_alt']);
    }

    public function testRejectsThirdIpWithoutRoaming(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $this->hosts->create('triple.test', $apiKey, true);

        $this->service->authenticate($apiKey, '203.0.113.11');
        $this->service->authenticate($apiKey, '2001:db8::2');

        $this->expectException(HttpException::class);
        $this->service->authenticate($apiKey, '203.0.113.99');
    }

    private function assertLogContains(string $action): void
    {
        foreach ($this->logs->events as $entry) {
            if ($entry[1] === $action) {
                return;
            }
        }
        self::fail(sprintf('Expected log action %s', $action));
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

final class DualStackLogRepository extends LogRepository
{
    /** @var array<int, array{0:?int,1:string,2:array}> */
    public array $events = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->events[] = [$hostId, $action, $details];
    }
}
