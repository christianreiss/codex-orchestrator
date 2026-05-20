<?php

declare(strict_types=1);

use App\Database;
use App\Repositories\HostRepository;
use App\Security\SecretBox;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Exercises the wrapper-v2 invalidation hooks: every host mutator that
 * touches a field embedded in the baked config must bump
 * hosts.config_version so the bakery re-bakes on the next fetch.
 */
final class HostRepositoryConfigVersionTest extends TestCase
{
    private \PDO $pdo;
    private HostRepository $repo;

    protected function setUp(): void
    {
        $this->pdo = new \PDO('sqlite::memory:', null, null, [\PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION]);
        $this->pdo->exec("CREATE TABLE hosts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            fqdn TEXT NOT NULL,
            api_key TEXT NOT NULL,
            api_key_hash TEXT,
            api_key_enc TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            secure INTEGER NOT NULL DEFAULT 1,
            curl_insecure INTEGER NOT NULL DEFAULT 0,
            browseros_mcp_enabled INTEGER NOT NULL DEFAULT 0,
            model_override TEXT,
            reasoning_effort_override TEXT,
            claude_model_override TEXT,
            config_version INTEGER NOT NULL DEFAULT 0,
            wrapper_track TEXT NOT NULL DEFAULT 'v2',
            updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z',
            created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00Z'
        )");
        $this->pdo->exec("INSERT INTO hosts (fqdn, api_key, api_key_hash) VALUES ('h.example.com','plainkey','hashed')");

        $database = $this->fakeDatabase($this->pdo);
        $secretBox = $this->createMock(SecretBox::class);
        $secretBox->method('encrypt')->willReturnArgument(0);
        $secretBox->method('decrypt')->willReturnArgument(0);
        $this->repo = new HostRepository($database, $secretBox);
    }

    public function testBumpConfigVersionIncrements(): void
    {
        $this->repo->bumpConfigVersion(1);
        self::assertSame(1, $this->repo->configVersion(1));
        $this->repo->bumpConfigVersion(1);
        self::assertSame(2, $this->repo->configVersion(1));
    }

    public function testBumpAllConfigVersionsTouchesEveryRow(): void
    {
        $this->pdo->exec("INSERT INTO hosts (fqdn, api_key, api_key_hash) VALUES ('h2.example.com','plainkey2','hashed2')");
        $affected = $this->repo->bumpAllConfigVersions();
        self::assertSame(2, $affected);
        self::assertSame(1, $this->repo->configVersion(1));
        self::assertSame(1, $this->repo->configVersion(2));
    }

    public function testUpdateSecureBumpsConfigVersion(): void
    {
        $start = $this->repo->configVersion(1);
        $this->repo->updateSecure(1, false);
        self::assertSame($start + 1, $this->repo->configVersion(1));
    }

    public function testUpdateModelOverridesBumpsConfigVersion(): void
    {
        $start = $this->repo->configVersion(1);
        $this->repo->updateModelOverrides(1, 'gpt-5.4', 'high');
        self::assertSame($start + 1, $this->repo->configVersion(1));
    }

    public function testUpdateClaudeModelOverrideBumpsConfigVersion(): void
    {
        $start = $this->repo->configVersion(1);
        $this->repo->updateClaudeModelOverride(1, 'claude-sonnet-4-6');
        self::assertSame($start + 1, $this->repo->configVersion(1));
    }

    public function testUpdateCurlInsecureBumpsConfigVersion(): void
    {
        $start = $this->repo->configVersion(1);
        $this->repo->updateCurlInsecure(1, true);
        self::assertSame($start + 1, $this->repo->configVersion(1));
    }

    public function testUpdateBrowserOsMcpBumpsConfigVersion(): void
    {
        $start = $this->repo->configVersion(1);
        $this->repo->updateBrowserOsMcp(1, true);
        self::assertSame($start + 1, $this->repo->configVersion(1));
    }

    public function testRotateApiKeyBumpsConfigVersion(): void
    {
        $start = $this->repo->configVersion(1);
        $this->repo->rotateApiKey(1, 'sk-codex-rotated');
        self::assertSame($start + 1, $this->repo->configVersion(1));
    }

    public function testWrapperTrackDefaultsToV2(): void
    {
        self::assertSame('v2', $this->repo->wrapperTrack(1));
    }

    public function testWrapperTrackReadsDisabled(): void
    {
        $this->pdo->exec("UPDATE hosts SET wrapper_track = 'disabled' WHERE id = 1");
        self::assertSame('disabled', $this->repo->wrapperTrack(1));
    }

    private function fakeDatabase(\PDO $pdo): Database
    {
        return new class($pdo) extends Database {
            public function __construct(private readonly \PDO $pdo)
            {
                // Skip the parent constructor — it would try to open a real connection.
            }
            public function connection(): \PDO
            {
                return $this->pdo;
            }
        };
    }
}
