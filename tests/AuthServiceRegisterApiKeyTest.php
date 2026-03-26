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

final class AuthServiceRegisterApiKeyTest extends TestCase
{
    private PDO $pdo;
    private HostRepository $hosts;
    private AuthServiceRegisterApiKeyLogRepository $logs;
    private AuthService $service;
    private ?string $originalGraceEnv = null;

    protected function setUp(): void
    {
        if (array_key_exists('INSECURE_GRACE_MINUTES', $_ENV)) {
            $this->originalGraceEnv = (string) $_ENV['INSECURE_GRACE_MINUTES'];
        } else {
            $envValue = getenv('INSECURE_GRACE_MINUTES');
            $this->originalGraceEnv = $envValue === false ? null : (string) $envValue;
        }
        $_ENV['INSECURE_GRACE_MINUTES'] = '15';
        putenv('INSECURE_GRACE_MINUTES=15');

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
                ip4 TEXT NULL,
                ip6 TEXT NULL,
                client_version TEXT NULL,
                client_version_override TEXT NULL,
                wrapper_version TEXT NULL,
                api_calls INTEGER NOT NULL DEFAULT 0,
                expires_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = new SecretBox(str_repeat('k', SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
        $this->hosts = new HostRepository($database, $secretBox);
        $this->logs = new AuthServiceRegisterApiKeyLogRepository();

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

    protected function tearDown(): void
    {
        if ($this->originalGraceEnv === null) {
            unset($_ENV['INSECURE_GRACE_MINUTES']);
            putenv('INSECURE_GRACE_MINUTES');
        } else {
            $_ENV['INSECURE_GRACE_MINUTES'] = $this->originalGraceEnv;
            putenv('INSECURE_GRACE_MINUTES=' . $this->originalGraceEnv);
        }
    }

    public function testRegisterSecureIncludesApiKey(): void
    {
        $payload = $this->service->register('secure.test', true);

        self::assertSame('secure.test', $payload['fqdn']);
        self::assertTrue($payload['secure']);
        self::assertIsString($payload['api_key']);
        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $payload['api_key']);
    }

    public function testRegisterInsecureIncludesApiKeyAndMatchesEncryptedHostKey(): void
    {
        $payload = $this->service->register('insecure.test', false);

        self::assertSame('insecure.test', $payload['fqdn']);
        self::assertFalse($payload['secure']);
        self::assertIsString($payload['api_key']);
        self::assertMatchesRegularExpression('/^[a-f0-9]{64}$/', $payload['api_key']);
        self::assertNotEmpty($payload['insecure_enabled_until']);
        self::assertNotEmpty($payload['insecure_grace_until']);

        $hostRow = $this->hosts->findByFqdn('insecure.test');
        self::assertNotNull($hostRow);
        self::assertArrayHasKey('api_key_enc', $hostRow);

        $enabledTs = strtotime((string) $payload['insecure_enabled_until']);
        $graceTs = strtotime((string) $payload['insecure_grace_until']);
        self::assertNotFalse($enabledTs);
        self::assertNotFalse($graceTs);
        self::assertSame(900, $graceTs - $enabledTs);

        $decrypted = $this->hosts->decryptApiKey($hostRow['api_key_enc']);
        self::assertSame($payload['api_key'], $decrypted);
    }

    public function testRegisterInsecureHonorsProvidedInitialWindowDuration(): void
    {
        $before = time();
        $payload = $this->service->register('insecure-custom.test', false, 45);
        $after = time();

        self::assertSame('insecure-custom.test', $payload['fqdn']);
        self::assertFalse($payload['secure']);
        self::assertSame(45, $payload['insecure_window_minutes']);

        $enabledTs = strtotime((string) $payload['insecure_enabled_until']);
        self::assertNotFalse($enabledTs);
        self::assertGreaterThanOrEqual($before + (45 * 60), $enabledTs);
        self::assertLessThanOrEqual($after + (45 * 60), $enabledTs);

        $hostRow = $this->hosts->findByFqdn('insecure-custom.test');
        self::assertNotNull($hostRow);
        self::assertSame(45, (int) ($hostRow['insecure_window_minutes'] ?? -1));
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

final class AuthServiceRegisterApiKeyLogRepository extends LogRepository
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
