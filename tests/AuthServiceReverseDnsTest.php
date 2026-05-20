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
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthServiceReverseDnsTest extends TestCase
{
    private PDO $pdo;
    private HostRepository $hosts;
    private VersionRepository $versions;
    private ReverseDnsLogRepository $logs;
    private TestReverseDnsAuthService $service;

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
                engines TEXT NOT NULL DEFAULT "codex",
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('x', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->hosts = new HostRepository($database, $secretBox);
        $this->logs = new ReverseDnsLogRepository();

        $this->versions = $this->createMock(VersionRepository::class);
        $this->service = new TestReverseDnsAuthService(
            $this->hosts,
            $this->createMock(AuthPayloadRepository::class),
            $this->createMock(HostAuthStateRepository::class),
            $this->createMock(HostAuthDigestRepository::class),
            $this->createMock(HostUserRepository::class),
            $this->logs,
            $this->createMock(TokenUsageRepository::class),
            $this->createMock(TokenUsageIngestRepository::class),
            $this->versions,
            $this->createMock(WrapperService::class),
            null,
        );
    }

    public function testEnforcesForwardAndPtrWhenEnabled(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $this->hosts->create('reverse.test', $apiKey, true);

        $this->versions
            ->method('getFlag')
            ->willReturnCallback(static fn (string $name, bool $default = false): bool => $name === 'reverse_dns_enabled');

        $this->service->forward['reverse.test'] = ['203.0.113.10'];
        $this->service->ptr['203.0.113.10'] = ['reverse.test'];

        $host = $this->service->authenticate($apiKey, '203.0.113.10', false, true);
        self::assertSame('reverse.test', $host['fqdn']);
    }

    public function testRejectsWhenForwardLookupDoesNotMatch(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $this->hosts->create('forward.test', $apiKey, true);

        $this->versions
            ->method('getFlag')
            ->willReturnCallback(static fn (string $name, bool $default = false): bool => $name === 'reverse_dns_enabled');

        $this->service->forward['forward.test'] = ['203.0.113.11'];
        $this->service->ptr['203.0.113.10'] = ['forward.test'];

        $this->expectException(HttpException::class);
        $this->service->authenticate($apiKey, '203.0.113.10', false, true);
    }

    public function testHostOverrideDisabledSkipsReverseDns(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create('override-off.test', $apiKey, true);
        $this->hosts->updateReverseDnsMode((int) $host['id'], false);

        $this->versions
            ->method('getFlag')
            ->willReturnCallback(static fn (string $name, bool $default = false): bool => $name === 'reverse_dns_enabled');

        $this->service->forward['override-off.test'] = [];
        $this->service->ptr['203.0.113.20'] = [];

        $result = $this->service->authenticate($apiKey, '203.0.113.20', false, true);
        self::assertSame('override-off.test', $result['fqdn']);
    }

    public function testHostOverrideEnabledForcesReverseDns(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $host = $this->hosts->create('override-on.test', $apiKey, true);
        $this->hosts->updateReverseDnsMode((int) $host['id'], true);

        $this->versions
            ->method('getFlag')
            ->willReturnCallback(static fn (string $name, bool $default = false): bool => false);

        $this->service->forward['override-on.test'] = ['203.0.113.30'];
        $this->service->ptr['203.0.113.30'] = ['override-on.test'];

        $result = $this->service->authenticate($apiKey, '203.0.113.30', false, true);
        self::assertSame('override-on.test', $result['fqdn']);
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

final class TestReverseDnsAuthService extends AuthService
{
    /** @var array<string, string[]> */
    public array $forward = [];
    /** @var array<string, string[]> */
    public array $ptr = [];

    protected function createReverseDnsValidator(\App\Repositories\VersionRepository $versions): \App\Services\ReverseDnsValidator
    {
        return new TestReverseDnsValidator($versions, $this);
    }
}

final class TestReverseDnsValidator extends \App\Services\ReverseDnsValidator
{
    public function __construct(
        \App\Repositories\VersionRepository $versions,
        private readonly TestReverseDnsAuthService $testService
    ) {
        parent::__construct($versions);
    }

    public function resolveForwardIps(string $fqdn): array
    {
        return $this->testService->forward[$fqdn] ?? [];
    }

    public function resolvePtrHosts(string $ip): array
    {
        return $this->testService->ptr[$ip] ?? [];
    }
}

final class ReverseDnsLogRepository extends LogRepository
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
