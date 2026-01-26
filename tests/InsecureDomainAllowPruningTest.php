<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\InsecureDomainAllowRepository;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class InsecureDomainAllowPruningTest extends TestCase
{
    private PDO $pdo;
    private InsecureDomainAllowRepository $repo;

    protected function setUp(): void
    {
        $this->pdo = new PDO('sqlite::memory:');
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);

        $this->pdo->exec(
            'CREATE TABLE insecure_domain_allows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                domain TEXT NOT NULL,
                window_minutes INTEGER NOT NULL,
                enabled_until TEXT NULL,
                revoked_at TEXT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )'
        );

        $database = $this->fakeDatabase($this->pdo);
        $this->repo = new InsecureDomainAllowRepository($database);
    }

    public function testRevokeExpiredPurgesWindowExpiredDomains(): void
    {
        $now = time();
        $nowIso = gmdate(DATE_ATOM, $now);
        $expiredIso = gmdate(DATE_ATOM, $now - 90);
        $futureIso = gmdate(DATE_ATOM, $now + 3600);

        $seed = $this->pdo->prepare(
            'INSERT INTO insecure_domain_allows (domain, window_minutes, enabled_until, revoked_at, created_at, updated_at)
             VALUES (:domain, :window_minutes, :enabled_until, :revoked_at, :created_at, :updated_at)'
        );
        $seed->execute([
            'domain' => 'expired.example',
            'window_minutes' => 10,
            'enabled_until' => $expiredIso,
            'revoked_at' => null,
            'created_at' => $expiredIso,
            'updated_at' => $expiredIso,
        ]);
        $seed->execute([
            'domain' => 'future.example',
            'window_minutes' => 10,
            'enabled_until' => $futureIso,
            'revoked_at' => null,
            'created_at' => $futureIso,
            'updated_at' => $futureIso,
        ]);
        $seed->execute([
            'domain' => 'already.revoked',
            'window_minutes' => 10,
            'enabled_until' => $expiredIso,
            'revoked_at' => $expiredIso,
            'created_at' => $expiredIso,
            'updated_at' => $expiredIso,
        ]);

        $affected = $this->repo->revokeExpired($nowIso);
        self::assertSame(1, $affected);

        $expired = $this->fetchAllow('expired.example');
        self::assertSame($nowIso, $expired['revoked_at']);

        $future = $this->fetchAllow('future.example');
        self::assertNull($future['revoked_at']);

        $revoked = $this->fetchAllow('already.revoked');
        self::assertSame($expiredIso, $revoked['revoked_at']);
    }

    private function fetchAllow(string $domain): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT domain, revoked_at FROM insecure_domain_allows WHERE domain = :domain LIMIT 1'
        );
        $stmt->execute(['domain' => $domain]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        self::assertIsArray($row);

        return $row;
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
