<?php

declare(strict_types=1);

use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\VersionRepository;
use App\Services\RunnerValidationService;
use App\Services\RunnerVerifier;
use App\Support\WorkerHeartbeat;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

/**
 * End-to-end-ish coverage for the preflight-cron tick script's core invariants.
 *
 * We cannot easily exercise scripts/preflight-cron-tick.php directly (it wires a real
 * MySQL connection), so we reimplement its high-level flow here over mocked
 * repositories to cover state transitions, canonical pointer movement, and heartbeat
 * artifacts. The one-to-one mapping between this harness and the tick script is
 * intentional: it guards the sequencing the script depends on.
 */
final class PreflightCronTickTest extends TestCase
{
    private const TOKEN = 'sk-abcdefghijklmnopqrstuvwxyz9876';
    private const LAST_REFRESH = '2024-08-01T10:00:00Z';

    public function testTickPromotesPendingPayloadAndWritesHealthyHeartbeat(): void
    {
        $tempHealth = tempnam(sys_get_temp_dir(), 'preflight');
        self::assertIsString($tempHealth);

        try {
            $heartbeat = new WorkerHeartbeat($tempHealth);
            $heartbeat->recordAttempt();

            $pending = $this->buildPendingRow(901);

            $payloads = $this->createMock(AuthPayloadRepository::class);
            $payloads->method('allPending')
                ->willReturnCallback(function (string $engine) use ($pending): array {
                    return $engine === 'codex' ? [$pending] : [];
                });
            $payloads->expects(self::once())
                ->method('markVerified')
                ->with(901, self::anything());
            $payloads->method('deleteRejectedOlderThan')->willReturn(0);

            $hosts = $this->createMock(HostRepository::class);
            $hosts->method('all')->willReturn([]);
            $hostStates = $this->createMock(HostAuthStateRepository::class);
            $logs = $this->createMock(LogRepository::class);

            $stored = [];
            $versions = $this->createMock(VersionRepository::class);
            $versions->method('get')->willReturn(null);
            $versions->method('getWithMetadata')->willReturn(null);
            $versions->method('set')->willReturnCallback(function (string $key, string $value) use (&$stored): void {
                $stored[$key] = $value;
            });

            $runner = $this->createMock(RunnerVerifier::class);
            $runner->method('verify')->willReturn([
                'status' => 'ok',
                'reachable' => true,
                'latency_ms' => 10,
            ]);

            $svc = new RunnerValidationService(
                $hosts,
                $payloads,
                $hostStates,
                $logs,
                $versions,
                $runner
            );

            $verifiedCount = 0;
            $rejectedCount = 0;
            foreach (['codex', 'claude'] as $engine) {
                foreach ($payloads->allPending($engine) as $row) {
                    $outcome = $svc->verifyPendingPayload($row, $engine);
                    match ($outcome['state']) {
                        'verified' => $verifiedCount++,
                        'rejected' => $rejectedCount++,
                        default => null,
                    };
                }
            }

            $heartbeat->recordSuccess([
                'summary' => sprintf('pending verified=%d rejected=%d', $verifiedCount, $rejectedCount),
                'pending_verified' => $verifiedCount,
                'pending_rejected' => $rejectedCount,
            ]);

            $this->assertSame(1, $verifiedCount);
            $this->assertSame(0, $rejectedCount);
            $this->assertSame('901', $stored['canonical_payload_id'] ?? null);

            $health = $heartbeat->evaluateHealth(3600, 120);
            $this->assertTrue($health['healthy']);
            $this->assertSame('fresh_success', $health['reason']);
            $this->assertSame(1, $health['data']['pending_verified'] ?? null);
        } finally {
            @unlink($tempHealth);
        }
    }

    public function testTickRejectsBadPendingAndDoesNotMoveCanonical(): void
    {
        $tempHealth = tempnam(sys_get_temp_dir(), 'preflight');
        self::assertIsString($tempHealth);

        try {
            $heartbeat = new WorkerHeartbeat($tempHealth);
            $heartbeat->recordAttempt();

            $pending = $this->buildPendingRow(902);

            $payloads = $this->createMock(AuthPayloadRepository::class);
            $payloads->method('allPending')
                ->willReturnCallback(function (string $engine) use ($pending): array {
                    return $engine === 'codex' ? [$pending] : [];
                });
            $payloads->expects(self::once())
                ->method('markRejected')
                ->with(902, self::anything());
            $payloads->expects(self::never())->method('markVerified');
            $payloads->method('deleteRejectedOlderThan')->willReturn(0);

            $hosts = $this->createMock(HostRepository::class);
            $hosts->method('all')->willReturn([]);
            $hostStates = $this->createMock(HostAuthStateRepository::class);
            $logs = $this->createMock(LogRepository::class);

            $stored = [];
            $versions = $this->createMock(VersionRepository::class);
            $versions->method('get')->willReturn(null);
            $versions->method('getWithMetadata')->willReturn(null);
            $versions->method('set')->willReturnCallback(function (string $key, string $value) use (&$stored): void {
                $stored[$key] = $value;
            });

            $runner = $this->createMock(RunnerVerifier::class);
            $runner->method('verify')->willReturn([
                'status' => 'fail',
                'reachable' => true,
                'latency_ms' => 11,
                'reason' => 'token revoked',
            ]);

            $svc = new RunnerValidationService(
                $hosts,
                $payloads,
                $hostStates,
                $logs,
                $versions,
                $runner
            );

            $outcome = $svc->verifyPendingPayload($pending);

            $heartbeat->recordSuccess([
                'summary' => 'pending verified=0 rejected=1',
                'pending_verified' => 0,
                'pending_rejected' => 1,
            ]);

            $this->assertSame('rejected', $outcome['state']);
            $this->assertArrayNotHasKey('canonical_payload_id', $stored);

            $health = $heartbeat->evaluateHealth(3600, 120);
            $this->assertTrue($health['healthy']);
        } finally {
            @unlink($tempHealth);
        }
    }

    public function testTickScriptAndHealthCheckExistAndLintClean(): void
    {
        $tick = __DIR__ . '/../scripts/preflight-cron-tick.php';
        $health = __DIR__ . '/../scripts/check-preflight-cron-health.php';

        self::assertFileExists($tick);
        self::assertFileExists($health);

        foreach ([$tick, $health] as $path) {
            $output = [];
            $status = 1;
            @exec('php -l ' . escapeshellarg($path) . ' 2>&1', $output, $status);
            self::assertSame(0, $status, 'PHP lint failed for ' . $path . ': ' . implode("\n", $output));
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function buildPendingRow(int $id): array
    {
        $auth = [
            'last_refresh' => self::LAST_REFRESH,
            'auths' => [
                'api.openai.com' => [
                    'token' => self::TOKEN,
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $encoded = json_encode($auth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        self::assertIsString($encoded);

        return [
            'id' => $id,
            'last_refresh' => self::LAST_REFRESH,
            'sha256' => hash('sha256', $encoded),
            'source_host_id' => null,
            'body' => $encoded,
            'engine' => 'codex',
            'verification_state' => 'pending',
            'entries' => [],
        ];
    }
}
