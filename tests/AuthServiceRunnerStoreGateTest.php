<?php

declare(strict_types=1);

use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\RunnerValidationService;
use App\Services\RunnerVerifier;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class StubRunnerVerifier extends RunnerVerifier
{
    public function __construct(private readonly array $result)
    {
        parent::__construct('http://runner.test/verify', 'http://api.test');
    }

    public function verify(array $authPayload, ?string $baseUrl = null, ?float $timeoutSeconds = null, ?array $host = null): array
    {
        return $this->result;
    }
}

final class AuthServiceRunnerStoreGateTest extends TestCase
{
    private function buildService(AuthPayloadRepository $payloads, ?RunnerVerifier $runner, ?VersionRepository $versions = null): AuthService
    {
        $host = [
            'id' => 1,
            'fqdn' => 'host.test',
            'status' => 'active',
            'api_calls' => 0,
            'secure' => 1,
        ];

        $hosts = $this->createMock(HostRepository::class);
        $hosts->method('updateClientVersions');
        $hosts->method('incrementApiCalls');
        $hosts->method('findById')->willReturn($host);
        $hosts->method('updateSyncState');
        $hosts->method('updateSyncStateForEngine');
        $hosts->method('all')->willReturn([$host]);

        $hostStates = $this->createMock(HostAuthStateRepository::class);
        $hostStates->method('upsert');

        $digests = $this->createMock(HostAuthDigestRepository::class);
        $digests->method('rememberDigests');
        $digests->method('recentDigests')->willReturn([]);

        $hostUsers = $this->createMock(HostUserRepository::class);
        $logs = $this->createMock(LogRepository::class);

        $tokenUsages = $this->createMock(TokenUsageRepository::class);
        $tokenUsages->method('totalsForHostRange')->willReturn([
            'total' => 0,
            'input' => 0,
            'output' => 0,
            'cached' => 0,
            'reasoning' => 0,
            'events' => 0,
        ]);
        $tokenUsageIngests = $this->createMock(TokenUsageIngestRepository::class);

        if ($versions === null) {
            $versions = $this->createMock(VersionRepository::class);
            $versions->method('getWithMetadata')->willReturn(null);
            $versions->method('get')->willReturn(null);
            $versions->method('set');
            $versions->method('getFlag')->willReturnCallback(static function (string $name, bool $default = false): bool {
                return $default;
            });
        }

        $wrapper = $this->createMock(WrapperService::class);
        $wrapper->method('metadata')->willReturn([
            'version' => null,
            'sha256' => null,
            'url' => null,
        ]);

        return new AuthService(
            $hosts,
            $payloads,
            $hostStates,
            $digests,
            $hostUsers,
            $logs,
            $tokenUsages,
            $tokenUsageIngests,
            $versions,
            $wrapper,
            null,
            $runner
        );
    }

    public function testStoreAcceptsImmediatelyWithRunnerUnreachable(): void
    {
        $payloads = $this->createMock(AuthPayloadRepository::class);
        $payloads->method('latest')->willReturn(null);
        $payloads->method('latestVerified')->willReturn(null);
        $payloads->method('findByIdWithEntries')->willReturn(null);

        // Store must call create() exactly once, with verification_state=pending.
        $payloads
            ->expects($this->once())
            ->method('create')
            ->willReturnCallback(
                function (
                    string $lastRefresh,
                    string $sha256,
                    ?int $sourceHostId,
                    array $entries,
                    ?string $extrasJson = null,
                    string $engine = 'codex',
                    string $verificationState = AuthPayloadRepository::STATE_PENDING
                ): array {
                    $this->assertSame(AuthPayloadRepository::STATE_PENDING, $verificationState);

                    return [
                        'id' => 42,
                        'last_refresh' => $lastRefresh,
                        'sha256' => $sha256,
                        'source_host_id' => $sourceHostId,
                        'body' => $extrasJson,
                        'entries' => $entries,
                        'verification_state' => $verificationState,
                        'created_at' => gmdate(DATE_ATOM),
                    ];
                }
            );

        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getWithMetadata')->willReturn(null);
        $versions->method('get')->willReturn(null);
        $versions->method('getFlag')->willReturnCallback(static fn (string $name, bool $default = false): bool => $default);
        // Critical: the store path must NOT set canonical_payload_id.
        $versions->expects($this->never())
            ->method('set')
            ->with(
                $this->logicalOr('canonical_payload_id', 'canonical_payload_id_claude'),
                $this->anything()
            );

        // Runner is configured but unreachable — the hot path must NOT call it.
        $runner = $this->createMock(RunnerVerifier::class);
        $runner->expects($this->never())->method('verify');

        $service = $this->buildService($payloads, $runner, $versions);

        $response = $service->handleAuth(
            [
                'command' => 'store',
                'auth' => [
                    'last_refresh' => '2026-01-02T00:00:00Z',
                    'auths' => [
                        'api.openai.com' => [
                            'token' => 'sk-test-1234567890abcdefghijklmnop',
                        ],
                    ],
                ],
            ],
            [
                'id' => 1,
                'fqdn' => 'host.test',
                'status' => 'active',
                'api_calls' => 0,
                'secure' => 1,
            ],
            '1.0.0',
            null,
            null
        );

        $this->assertSame('updated', $response['status'] ?? null);
        $this->assertSame(AuthPayloadRepository::STATE_PENDING, $response['verification_state'] ?? null);
        $this->assertSame(42, $response['pending_payload_id'] ?? null);
        $this->assertFalse($response['runner_applied'] ?? true);
    }

    public function testCronVerifyPromotesPendingOnRunnerOk(): void
    {
        $pending = [
            'id' => 501,
            'last_refresh' => '2026-01-02T00:00:00Z',
            'sha256' => hash('sha256', json_encode([
                'last_refresh' => '2026-01-02T00:00:00Z',
                'auths' => [
                    'api.openai.com' => [
                        'token' => 'sk-test-1234567890abcdefghijklmnop',
                        'token_type' => 'bearer',
                    ],
                ],
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
            'engine' => 'codex',
            'verification_state' => 'pending',
            'source_host_id' => null,
            'body' => null,
            'entries' => [[
                'target' => 'api.openai.com',
                'token' => 'sk-test-1234567890abcdefghijklmnop',
                'token_type' => 'bearer',
                'organization' => null,
                'project' => null,
                'api_base' => null,
                'meta' => null,
            ]],
        ];

        $payloads = $this->createMock(AuthPayloadRepository::class);
        $payloads->expects($this->once())->method('markVerified')->with(501, $this->anything());

        $hosts = $this->createMock(HostRepository::class);
        $hosts->method('all')->willReturn([]);
        $hostStates = $this->createMock(HostAuthStateRepository::class);
        $logs = $this->createMock(LogRepository::class);

        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')->willReturn(null);
        $versions->method('getFlag')->willReturnCallback(static fn (string $name, bool $default = false): bool => $default);
        $versions->expects($this->atLeastOnce())
            ->method('set')
            ->willReturnCallback(function (string $key, string $value): void {
                if ($key === 'canonical_payload_id') {
                    $this->assertSame('501', $value);
                }
            });

        $runner = new StubRunnerVerifier([
            'status' => 'ok',
            'reachable' => true,
            'latency_ms' => 12,
        ]);

        $service = new RunnerValidationService(
            $hosts,
            $payloads,
            $hostStates,
            $logs,
            $versions,
            $runner
        );

        $outcome = $service->verifyPendingPayload($pending);

        $this->assertSame('verified', $outcome['state']);
        $this->assertTrue($outcome['canonical_moved']);
        $this->assertSame(501, $outcome['canonical_payload_id']);
    }

    public function testCronVerifyRejectsPendingOnRunnerFail(): void
    {
        $pending = [
            'id' => 601,
            'last_refresh' => '2026-01-02T00:00:00Z',
            'sha256' => hash('sha256', json_encode([
                'last_refresh' => '2026-01-02T00:00:00Z',
                'auths' => [
                    'api.openai.com' => [
                        'token' => 'sk-bad-1234567890abcdefghijklmnop',
                        'token_type' => 'bearer',
                    ],
                ],
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
            'engine' => 'codex',
            'verification_state' => 'pending',
            'source_host_id' => null,
            'body' => null,
            'entries' => [[
                'target' => 'api.openai.com',
                'token' => 'sk-bad-1234567890abcdefghijklmnop',
                'token_type' => 'bearer',
                'organization' => null,
                'project' => null,
                'api_base' => null,
                'meta' => null,
            ]],
        ];

        $payloads = $this->createMock(AuthPayloadRepository::class);
        $payloads->expects($this->once())->method('markRejected')->with(601, $this->anything());
        $payloads->expects($this->never())->method('markVerified');

        $hosts = $this->createMock(HostRepository::class);
        $hosts->method('all')->willReturn([]);
        $hostStates = $this->createMock(HostAuthStateRepository::class);
        $logs = $this->createMock(LogRepository::class);

        $versions = $this->createMock(VersionRepository::class);
        $versions->method('get')->willReturn(null);
        $versions->method('getFlag')->willReturnCallback(static fn (string $name, bool $default = false): bool => $default);
        $stored = [];
        $versions->method('set')->willReturnCallback(function (string $key, string $value) use (&$stored): void {
            $stored[$key] = $value;
        });

        $runner = new StubRunnerVerifier([
            'status' => 'fail',
            'reachable' => true,
            'latency_ms' => 13,
            'reason' => 'invalid token',
        ]);

        $service = new RunnerValidationService(
            $hosts,
            $payloads,
            $hostStates,
            $logs,
            $versions,
            $runner
        );

        $outcome = $service->verifyPendingPayload($pending);

        $this->assertSame('rejected', $outcome['state']);
        $this->assertFalse($outcome['canonical_moved']);
        // Canonical pointer must not move on rejection.
        $this->assertArrayNotHasKey('canonical_payload_id', $stored);
        $this->assertArrayNotHasKey('canonical_payload_id_claude', $stored);
    }
}
