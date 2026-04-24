<?php

declare(strict_types=1);

use App\Repositories\HostRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\ClientVersionService;
use App\Services\RunnerVerifier;
use App\Services\WrapperService;
use App\Support\CodexVersionPolicy;
use App\Support\Engine;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * Unit tests for ClientVersionService.
 *
 * Covers pure / near-pure public methods that can be exercised without a
 * real database connection:
 *   - normalizeClientVersion()             pure wrapper around CodexVersionPolicy
 *   - applyClientVersionOverrideForHost()  pure array transform
 *   - latestReportedVersions()             reads HostRepository (mocked)
 *   - quotaLimitPercent()                  reads VersionRepository (mocked)
 *   - quotaWeekPartition()                 reads VersionRepository (mocked)
 *
 * Methods that require network I/O (availableClientVersion with GitHub fetch)
 * or full service integration (versionSnapshot) are exercised in broader
 * AuthService bootstrap and client-version-lock integration tests.
 */
final class ClientVersionServiceTest extends TestCase
{
    /** @var HostRepository&\PHPUnit\Framework\MockObject\MockObject */
    private HostRepository $hosts;

    /** @var VersionRepository&\PHPUnit\Framework\MockObject\MockObject */
    private VersionRepository $versions;

    /** @var WrapperService&\PHPUnit\Framework\MockObject\MockObject */
    private WrapperService $wrapper;

    private ClientVersionService $svc;

    protected function setUp(): void
    {
        $this->hosts = $this->getMockBuilder(HostRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['all'])
            ->getMock();

        $this->versions = $this->getMockBuilder(VersionRepository::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['get', 'getWithMetadata', 'getFlag', 'set'])
            ->getMock();

        $this->wrapper = $this->getMockBuilder(WrapperService::class)
            ->disableOriginalConstructor()
            ->onlyMethods(['metadata'])
            ->getMock();

        $this->svc = new ClientVersionService(
            $this->hosts,
            $this->versions,
            $this->wrapper,
            null,          // runnerVerifier — not needed for these tests
            'test-install' // installationId
        );
    }

    // -------------------------------------------------------------------------
    // normalizeClientVersion
    // -------------------------------------------------------------------------

    public function testNormalizeClientVersionReturnsUnknownForNull(): void
    {
        $this->assertSame('unknown', $this->svc->normalizeClientVersion(null));
    }

    public function testNormalizeClientVersionReturnsUnknownForEmptyString(): void
    {
        $this->assertSame('unknown', $this->svc->normalizeClientVersion(''));
    }

    public function testNormalizeClientVersionReturnsUnknownForWhitespaceOnly(): void
    {
        $this->assertSame('unknown', $this->svc->normalizeClientVersion('   '));
    }

    public function testNormalizeClientVersionStripsRustPrefix(): void
    {
        $this->assertSame('0.120.0', $this->svc->normalizeClientVersion('rust-v0.120.0'));
    }

    public function testNormalizeClientVersionStripsVPrefix(): void
    {
        $this->assertSame('0.120.0', $this->svc->normalizeClientVersion('v0.120.0'));
    }

    public function testNormalizeClientVersionStripsCodexCliPrefix(): void
    {
        // "codex-cli" prefix followed by a space/v — the regex strips "codex-cli\s*",
        // then ltrim strips the leading 'v', yielding a bare semver.
        $this->assertSame('0.120.0', $this->svc->normalizeClientVersion('codex-cli v0.120.0'));
    }

    public function testNormalizeClientVersionPassesThroughBareSemanticVersion(): void
    {
        $this->assertSame('1.2.3', $this->svc->normalizeClientVersion('1.2.3'));
    }

    public function testNormalizeClientVersionTrimsWhitespace(): void
    {
        $this->assertSame('0.120.0', $this->svc->normalizeClientVersion('  0.120.0  '));
    }

    // -------------------------------------------------------------------------
    // applyClientVersionOverrideForHost
    // -------------------------------------------------------------------------

    public function testApplyOverrideReturnsVersionsUnchangedWhenOverrideIsNull(): void
    {
        $versions = ['client_version' => '0.120.0', 'client_version_source' => 'github'];
        $host = ['client_version_override' => null];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($versions, $result);
    }

    public function testApplyOverrideReturnsVersionsUnchangedWhenOverrideIsNotString(): void
    {
        $versions = ['client_version' => '0.120.0'];
        $host = ['client_version_override' => 42];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($versions, $result);
    }

    public function testApplyOverrideReturnsVersionsUnchangedWhenOverrideIsEmptyString(): void
    {
        $versions = ['client_version' => '0.120.0'];
        $host = ['client_version_override' => ''];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($versions, $result);
    }

    public function testApplyOverrideReturnsVersionsUnchangedWhenOverrideIsGlobal(): void
    {
        $versions = ['client_version' => '0.120.0'];
        $host = ['client_version_override' => 'global'];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($versions, $result);
    }

    public function testApplyOverrideReturnsVersionsUnchangedWhenOverrideIsGlobalCaseInsensitive(): void
    {
        $versions = ['client_version' => '0.120.0'];
        $host = ['client_version_override' => 'GLOBAL'];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($versions, $result);
    }

    public function testApplyOverrideReplacesClientVersionWithValidOverride(): void
    {
        $versions = ['client_version' => '0.120.0', 'client_version_source' => 'github'];
        $host = ['client_version_override' => '0.200.0'];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame('0.200.0', $result['client_version']);
        $this->assertSame('locked', $result['client_version_source']);
        $this->assertNull($result['client_version_checked_at']);
        $this->assertTrue($result['client_version_enforce_exact']);
    }

    public function testApplyOverrideStripsVersionPrefixInOverride(): void
    {
        $versions = ['client_version' => '0.120.0'];
        $host = ['client_version_override' => 'rust-v0.200.0'];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame('0.200.0', $result['client_version']);
    }

    public function testApplyOverrideClampsOverrideBelowMinimumToMinimum(): void
    {
        // A version at or below MINIMUM_VERSION should be raised to the floor
        $minimum = CodexVersionPolicy::MINIMUM_VERSION;
        $versions = ['client_version' => '0.200.0'];
        $host = ['client_version_override' => '0.001.0'];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($minimum, $result['client_version']);
        // enforce_exact is false when clamped to minimum floor
        $this->assertFalse($result['client_version_enforce_exact']);
    }

    public function testApplyOverrideKeyMissingFromHostArrayReturnsVersionsUnchanged(): void
    {
        $versions = ['client_version' => '0.120.0'];
        $host = [];

        $result = $this->svc->applyClientVersionOverrideForHost($versions, $host);

        $this->assertSame($versions, $result);
    }

    // -------------------------------------------------------------------------
    // latestReportedVersions
    // -------------------------------------------------------------------------

    public function testLatestReportedVersionsReturnsNullClientVersionWhenNoHosts(): void
    {
        $this->hosts->method('all')->willReturn([]);

        $result = $this->svc->latestReportedVersions();

        $this->assertNull($result['client_version']);
        $this->assertNull($result['wrapper_version']);
    }

    public function testLatestReportedVersionsReturnsNullWhenAllHostsHaveNoVersion(): void
    {
        $this->hosts->method('all')->willReturn([
            ['id' => 1, 'client_version' => null, 'wrapper_version' => null],
            ['id' => 2, 'client_version' => '', 'wrapper_version' => ''],
        ]);

        $result = $this->svc->latestReportedVersions();

        $this->assertNull($result['client_version']);
        $this->assertNull($result['wrapper_version']);
    }

    public function testLatestReportedVersionsReturnsSingleHostVersion(): void
    {
        $this->hosts->method('all')->willReturn([
            ['id' => 1, 'client_version' => '0.120.0', 'wrapper_version' => '2026.03.24-01'],
        ]);

        $result = $this->svc->latestReportedVersions();

        $this->assertSame('0.120.0', $result['client_version']);
        $this->assertSame('2026.03.24-01', $result['wrapper_version']);
    }

    public function testLatestReportedVersionsPicksHighestVersionAcrossHosts(): void
    {
        $this->hosts->method('all')->willReturn([
            ['id' => 1, 'client_version' => '0.120.0', 'wrapper_version' => '2026.03.24-01'],
            ['id' => 2, 'client_version' => '0.200.0', 'wrapper_version' => '2026.03.24-03'],
            ['id' => 3, 'client_version' => '0.150.0', 'wrapper_version' => '2026.03.24-02'],
        ]);

        $result = $this->svc->latestReportedVersions();

        $this->assertSame('0.200.0', $result['client_version']);
        $this->assertSame('2026.03.24-03', $result['wrapper_version']);
    }

    public function testLatestReportedVersionsIgnoresPrefixedVersionStrings(): void
    {
        // rust-v prefix is stripped by canonicalVersion before comparison
        $this->hosts->method('all')->willReturn([
            ['id' => 1, 'client_version' => '0.120.0'],
            ['id' => 2, 'client_version' => 'rust-v0.130.0'],
        ]);

        $result = $this->svc->latestReportedVersions();

        // canonicalVersion strips 'rust-v' → '0.130.0' > '0.120.0'
        $this->assertSame('0.130.0', $result['client_version']);
    }

    public function testLatestReportedVersionsSkipsHostsWithoutClientVersionKey(): void
    {
        $this->hosts->method('all')->willReturn([
            ['id' => 1],
            ['id' => 2, 'client_version' => '0.115.0'],
        ]);

        $result = $this->svc->latestReportedVersions();

        $this->assertSame('0.115.0', $result['client_version']);
    }

    // -------------------------------------------------------------------------
    // quotaLimitPercent
    // -------------------------------------------------------------------------

    public function testQuotaLimitPercentReturnsDefaultWhenNotStored(): void
    {
        $this->versions->method('get')->willReturn(null);

        $result = $this->svc->quotaLimitPercent();

        $this->assertSame(AuthService::DEFAULT_QUOTA_LIMIT_PERCENT, $result);
    }

    public function testQuotaLimitPercentReturnsStoredValidValue(): void
    {
        $this->versions->method('get')->willReturnCallback(
            static fn (string $key) => $key === 'quota_limit_percent' ? '80' : null
        );

        $result = $this->svc->quotaLimitPercent();

        $this->assertSame(80, $result);
    }

    public function testQuotaLimitPercentClampsLowValueToMinimum(): void
    {
        // normalizeQuotaLimitPercent clamps values below MIN (50) up to MIN rather than
        // returning null, so quotaLimitPercent() returns MIN_QUOTA_LIMIT_PERCENT (50).
        $this->versions->method('get')->willReturnCallback(
            static fn (string $key) => $key === 'quota_limit_percent' ? '10' : null
        );

        $result = $this->svc->quotaLimitPercent();

        $this->assertSame(AuthService::MIN_QUOTA_LIMIT_PERCENT, $result);
    }

    public function testQuotaLimitPercentReturnsDefaultForNonNumericStoredValue(): void
    {
        $this->versions->method('get')->willReturnCallback(
            static fn (string $key) => $key === 'quota_limit_percent' ? 'bad' : null
        );

        $result = $this->svc->quotaLimitPercent();

        $this->assertSame(AuthService::DEFAULT_QUOTA_LIMIT_PERCENT, $result);
    }

    // -------------------------------------------------------------------------
    // quotaWeekPartition
    // -------------------------------------------------------------------------

    public function testQuotaWeekPartitionReturnsDefaultWhenNotStored(): void
    {
        $this->versions->method('get')->willReturn(null);

        $result = $this->svc->quotaWeekPartition();

        $this->assertSame(AuthService::DEFAULT_QUOTA_WEEK_PARTITION, $result);
    }

    public function testQuotaWeekPartitionReturnsFiveDayWhenStored5(): void
    {
        $this->versions->method('get')->willReturnCallback(
            static fn (string $key) => $key === 'quota_week_partition' ? '5' : null
        );

        $result = $this->svc->quotaWeekPartition();

        $this->assertSame(AuthService::QUOTA_WEEK_PARTITION_FIVE_DAY, $result);
    }

    public function testQuotaWeekPartitionReturnsSevenDayWhenStored7(): void
    {
        $this->versions->method('get')->willReturnCallback(
            static fn (string $key) => $key === 'quota_week_partition' ? '7' : null
        );

        $result = $this->svc->quotaWeekPartition();

        $this->assertSame(AuthService::QUOTA_WEEK_PARTITION_SEVEN_DAY, $result);
    }

    public function testQuotaWeekPartitionReturnsDefaultForUnrecognizedValue(): void
    {
        $this->versions->method('get')->willReturnCallback(
            static fn (string $key) => $key === 'quota_week_partition' ? '99' : null
        );

        $result = $this->svc->quotaWeekPartition();

        $this->assertSame(AuthService::DEFAULT_QUOTA_WEEK_PARTITION, $result);
    }

    public function testClaudeVersionSnapshotUsesClaudeRunnerStateKeys(): void
    {
        $this->hosts->method('all')->willReturn([]);
        $this->wrapper->method('metadata')->with(Engine::CLAUDE)->willReturn([
            'version' => '1.2.3',
            'sha256' => str_repeat('a', 64),
            'url' => 'https://coord.example/wrapper/download?engine=claude',
        ]);
        $this->versions->method('getWithMetadata')->willReturnCallback(static function (string $key): ?array {
            if ($key === 'claude_fleet_version') {
                return ['version' => '1.2.3', 'updated_at' => '2026-04-24T00:00:00Z'];
            }
            return null;
        });
        $this->versions->method('getFlag')->willReturn(false);
        $this->versions->method('get')->willReturnCallback(static function (string $key): ?string {
            return match ($key) {
                'runner_state' => 'codex-ok',
                'runner_state_claude' => 'claude-fail',
                'runner_last_ok_claude' => '2026-04-24T01:00:00Z',
                'runner_last_fail_claude' => '2026-04-24T02:00:00Z',
                'runner_last_check_claude' => '2026-04-24T03:00:00Z',
                default => null,
            };
        });

        $snapshot = $this->svc->versionSnapshotForEngine(Engine::CLAUDE);

        $this->assertSame('claude-fail', $snapshot['runner_state']);
        $this->assertSame('2026-04-24T01:00:00Z', $snapshot['runner_last_ok']);
        $this->assertSame('2026-04-24T02:00:00Z', $snapshot['runner_last_fail']);
        $this->assertSame('2026-04-24T03:00:00Z', $snapshot['runner_last_check']);
    }
}
