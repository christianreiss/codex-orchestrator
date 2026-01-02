<?php

declare(strict_types=1);

use App\Exceptions\ValidationException;
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
use App\Services\PricingService;
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
    private function buildService(AuthPayloadRepository $payloads, RunnerVerifier $runner): AuthService
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
            'cost' => 0.0,
            'events' => 0,
        ]);
        $tokenUsageIngests = $this->createMock(TokenUsageIngestRepository::class);
        $pricing = $this->createMock(PricingService::class);

        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getWithMetadata')->willReturn(null);
        $versions->method('get')->willReturn(null);
        $versions->method('set');
        $versions->method('getFlag')->willReturnCallback(static function (string $name, bool $default = false): bool {
            return $default;
        });

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
            $pricing,
            $versions,
            $wrapper,
            $runner
        );
    }

    public function testStoreRejectedWhenRunnerFails(): void
    {
        $payloads = $this->createMock(AuthPayloadRepository::class);
        $payloads->method('latest')->willReturn(null);
        $payloads->method('findByIdWithEntries')->willReturn(null);
        $payloads->expects($this->never())->method('create');

        $runner = new StubRunnerVerifier([
            'status' => 'fail',
            'reachable' => true,
            'reason' => 'invalid token',
            'latency_ms' => 20,
        ]);

        $service = $this->buildService($payloads, $runner);

        $this->expectException(ValidationException::class);
        $service->handleAuth(
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
    }

    public function testStorePersistsAfterRunnerOk(): void
    {
        $payloads = $this->createMock(AuthPayloadRepository::class);
        $payloads->method('latest')->willReturn(null);
        $payloads->method('findByIdWithEntries')->willReturn(null);
        $payloads->expects($this->once())->method('create')->willReturnCallback(
            static function (string $lastRefresh, string $sha256, ?int $sourceHostId, array $entries, ?string $extrasJson): array {
                return [
                    'id' => 42,
                    'last_refresh' => $lastRefresh,
                    'sha256' => $sha256,
                    'source_host_id' => $sourceHostId,
                    'body' => $extrasJson,
                    'entries' => $entries,
                    'created_at' => gmdate(DATE_ATOM),
                ];
            }
        );

        $runner = new StubRunnerVerifier([
            'status' => 'ok',
            'reachable' => true,
            'latency_ms' => 12,
        ]);

        $service = $this->buildService($payloads, $runner);

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
        $this->assertFalse($response['runner_applied'] ?? true);
        $this->assertSame('ok', $response['validation']['status'] ?? null);
    }

    public function testStoreUpdatesWhenTimestampEqualButDigestDiffers(): void
    {
        $canonicalAuth = [
            'last_refresh' => '2026-01-02T00:00:00Z',
            'auths' => [
                'api.openai.com' => [
                    'token' => 'sk-old-1234567890abcdefghijklmnop',
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $canonicalDigest = hash('sha256', json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        $canonicalPayload = [
            'id' => 77,
            'last_refresh' => $canonicalAuth['last_refresh'],
            'sha256' => $canonicalDigest,
            'entries' => [
                [
                    'target' => 'api.openai.com',
                    'token' => $canonicalAuth['auths']['api.openai.com']['token'],
                    'token_type' => 'bearer',
                    'organization' => null,
                    'project' => null,
                    'api_base' => null,
                    'meta' => null,
                ],
            ],
        ];

        $payloads = $this->createMock(AuthPayloadRepository::class);
        $payloads->method('latest')->willReturn($canonicalPayload);
        $payloads->method('findByIdWithEntries')->willReturn($canonicalPayload);
        $payloads->expects($this->once())->method('create')->willReturnCallback(
            static function (string $lastRefresh, string $sha256, ?int $sourceHostId, array $entries, ?string $extrasJson): array {
                return [
                    'id' => 78,
                    'last_refresh' => $lastRefresh,
                    'sha256' => $sha256,
                    'source_host_id' => $sourceHostId,
                    'body' => $extrasJson,
                    'entries' => $entries,
                    'created_at' => gmdate(DATE_ATOM),
                ];
            }
        );

        $runner = new StubRunnerVerifier([
            'status' => 'ok',
            'reachable' => true,
            'latency_ms' => 8,
        ]);

        $service = $this->buildService($payloads, $runner);

        $response = $service->handleAuth(
            [
                'command' => 'store',
                'auth' => [
                    'last_refresh' => '2026-01-02T00:00:00Z',
                    'auths' => [
                        'api.openai.com' => [
                            'token' => 'sk-new-1234567890abcdefghijklmnop',
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
        $this->assertSame('2026-01-02T00:00:00Z', $response['canonical_last_refresh'] ?? null);
    }
}
