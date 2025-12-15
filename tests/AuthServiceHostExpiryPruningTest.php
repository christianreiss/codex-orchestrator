<?php

declare(strict_types=1);

use App\Database;
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

final class AuthServiceHostExpiryPruningTest extends TestCase
{
    private PDO $pdo;
    private HostRepository $hosts;
    private AuthServiceHostExpiryPruningLogRepository $logs;
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
                allow_roaming_ips INTEGER NOT NULL DEFAULT 0,
                last_refresh TEXT NULL,
                auth_digest TEXT NULL,
                api_calls INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('k', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->hosts = new HostRepository($database, $secretBox);
        $this->logs = new AuthServiceHostExpiryPruningLogRepository();

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
        );
    }

    public function testPruneStaleHostsDeletesExpiredHosts(): void
    {
        $now = time();
        $expiresAt = gmdate(DATE_ATOM, $now - 3600);
        $createdAt = gmdate(DATE_ATOM, $now - 60);

        $seed = $this->pdo->prepare(
            'INSERT INTO hosts (fqdn, api_key, status, secure, vip, allow_roaming_ips, last_refresh, auth_digest, api_calls, expires_at, created_at, updated_at)
             VALUES (:fqdn, :api_key, :status, :secure, :vip, :allow_roaming_ips, :last_refresh, :auth_digest, :api_calls, :expires_at, :created_at, :updated_at)'
        );
        $seed->execute([
            'fqdn' => 'expired.test',
            'api_key' => str_repeat('a', 64),
            'status' => 'active',
            'secure' => 1,
            'vip' => 0,
            'allow_roaming_ips' => 0,
            'last_refresh' => null,
            'auth_digest' => null,
            'api_calls' => 1,
            'expires_at' => $expiresAt,
            'created_at' => $createdAt,
            'updated_at' => $createdAt,
        ]);
        $hostId = (int) $this->pdo->lastInsertId();

        $this->service->pruneStaleHosts();

        self::assertNull($this->hosts->findById($hostId));

        $pruneEvents = array_values(array_filter(
            $this->logs->events,
            static fn (array $event): bool => $event[0] === $hostId && $event[1] === 'host.pruned'
        ));
        self::assertNotEmpty($pruneEvents);

        $details = $pruneEvents[0][2] ?? [];
        self::assertSame('expired', $details['reason'] ?? null);
        self::assertSame('expired.test', $details['fqdn'] ?? null);
    }

    public function testUnprovisionedTemporaryHostsAreNotPrunedBeforeExpiresAt(): void
    {
        $now = time();
        $expiresAt = gmdate(DATE_ATOM, $now + 3600);
        $createdAt = gmdate(DATE_ATOM, $now - 7200);

        $seed = $this->pdo->prepare(
            'INSERT INTO hosts (fqdn, api_key, status, secure, vip, allow_roaming_ips, last_refresh, auth_digest, api_calls, expires_at, created_at, updated_at)
             VALUES (:fqdn, :api_key, :status, :secure, :vip, :allow_roaming_ips, :last_refresh, :auth_digest, :api_calls, :expires_at, :created_at, :updated_at)'
        );
        $seed->execute([
            'fqdn' => 'temporary-unprovisioned.test',
            'api_key' => str_repeat('b', 64),
            'status' => 'active',
            'secure' => 1,
            'vip' => 0,
            'allow_roaming_ips' => 0,
            'last_refresh' => null,
            'auth_digest' => null,
            'api_calls' => 0,
            'expires_at' => $expiresAt,
            'created_at' => $createdAt,
            'updated_at' => $createdAt,
        ]);
        $hostId = (int) $this->pdo->lastInsertId();

        $this->service->pruneStaleHosts();

        self::assertNotNull($this->hosts->findById($hostId));
    }

    public function testAuthenticateRefreshesTemporaryHostExpiry(): void
    {
        $apiKey = bin2hex(random_bytes(32));
        $hash = hash('sha256', $apiKey);

        $now = time();
        $seedExpiresAt = gmdate(DATE_ATOM, $now + 60);
        $createdAt = gmdate(DATE_ATOM, $now - 60);

        $seed = $this->pdo->prepare(
            'INSERT INTO hosts (fqdn, api_key, api_key_hash, api_key_enc, status, secure, vip, allow_roaming_ips, last_refresh, auth_digest, api_calls, expires_at, created_at, updated_at)
             VALUES (:fqdn, :api_key, :api_key_hash, :api_key_enc, :status, :secure, :vip, :allow_roaming_ips, :last_refresh, :auth_digest, :api_calls, :expires_at, :created_at, :updated_at)'
        );
        $seed->execute([
            'fqdn' => 'temporary-refresh.test',
            'api_key' => $hash,
            'api_key_hash' => $hash,
            'api_key_enc' => null,
            'status' => 'active',
            'secure' => 1,
            'vip' => 0,
            'allow_roaming_ips' => 0,
            'last_refresh' => null,
            'auth_digest' => null,
            'api_calls' => 1,
            'expires_at' => $seedExpiresAt,
            'created_at' => $createdAt,
            'updated_at' => $createdAt,
        ]);
        $hostId = (int) $this->pdo->lastInsertId();

        $this->service->authenticate($apiKey, null);

        $hostAfter = $this->hosts->findById($hostId);
        self::assertNotNull($hostAfter);

        $refreshedExpiresAt = $hostAfter['expires_at'] ?? null;
        self::assertIsString($refreshedExpiresAt);
        self::assertNotSame($seedExpiresAt, $refreshedExpiresAt);

        $refreshedTs = strtotime($refreshedExpiresAt);
        self::assertIsInt($refreshedTs);

        $expectedMin = $now + 7190; // allow small slack for execution time
        $expectedMax = $now + 7500;
        self::assertGreaterThanOrEqual($expectedMin, $refreshedTs);
        self::assertLessThanOrEqual($expectedMax, $refreshedTs);
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

final class AuthServiceHostExpiryPruningLogRepository extends LogRepository
{
    public array $events = [];

    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
        $this->events[] = [$hostId, $action, $details];
    }
}
