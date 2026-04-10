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
use App\Services\PricingService;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthServiceHostClientVersionOverrideTest extends TestCase
{
    public function testHostOverrideRaisesLowVersionToMinimumFloor(): void
    {
        $host = [
            'id' => 1,
            'fqdn' => 'host.test',
            'status' => 'active',
            'secure' => 1,
            'vip' => 0,
            'api_calls' => 0,
            'client_version_override' => '0.101.0',
        ];

        $hosts = new class($host) extends HostRepository {
            public array $host;

            public function __construct(array $host)
            {
                $this->host = $host;
            }

            public function updateClientVersions(int $hostId, string $clientVersion, ?string $wrapperVersion): void
            {
                $this->host['client_version'] = $clientVersion;
                $this->host['wrapper_version'] = $wrapperVersion;
            }

            public function incrementApiCalls(int $hostId, int $by = 1): void
            {
                $this->host['api_calls'] = ($this->host['api_calls'] ?? 0) + $by;
            }

            public function findById(int $id): ?array
            {
                return $this->host;
            }

            public function updateSyncState(int $hostId, string $lastRefresh, string $authDigest): void
            {
                $this->host['last_refresh'] = $lastRefresh;
                $this->host['auth_digest'] = $authDigest;
            }

            public function all(): array
            {
                return [$this->host];
            }
        };

        $payloads = new class() extends AuthPayloadRepository {
            public function __construct()
            {
            }

            public function findByIdWithEntries(int $id, ?string $engine = null): ?array
            {
                return null;
            }

            public function latest(string $engine = 'codex'): ?array
            {
                return null;
            }
        };

        $hostStates = new class() extends HostAuthStateRepository {
            public function __construct()
            {
            }

            public function upsert(int $hostId, int $payloadId, string $digest, string $engine = 'codex'): void
            {
            }
        };

        $digests = new class() extends HostAuthDigestRepository {
            public function __construct()
            {
            }

            public function recentDigests(int $hostId, int $limit = 3, string $engine = 'codex'): array
            {
                return [];
            }

            public function rememberDigests(int $hostId, array $digests, int $retain = 3, string $engine = 'codex'): void
            {
            }
        };

        $hostUsers = new class() extends HostUserRepository {
            public function __construct()
            {
            }

            public function record(int $hostId, string $username, ?string $hostname = null): void
            {
            }

            public function listByHost(int $hostId): array
            {
                return [];
            }

            public function deleteByHostId(int $hostId): void
            {
            }
        };

        $logs = new class() extends LogRepository {
            public function __construct()
            {
            }

            public function log(?int $hostId, string $action, array $details = []): void
            {
            }
        };

        $tokenUsages = new class() extends TokenUsageRepository {
            public function __construct()
            {
            }

            public function totals(?int $hostId = null): array
            {
                return [
                    'total' => 0,
                    'input' => 0,
                    'output' => 0,
                    'cached' => 0,
                    'reasoning' => 0,
                    'cost' => 0.0,
                    'events' => 0,
                ];
            }

            public function totalsForRange(string $startIso, string $endIso): array
            {
                return $this->totals();
            }

            public function totalsForHostRange(int $hostId, string $startIso, string $endIso): array
            {
                return $this->totals();
            }

            public function record(
                ?int $hostId,
                ?int $total,
                ?int $input,
                ?int $output,
                ?int $cached,
                ?int $reasoning,
                ?float $cost,
                ?string $model,
                ?string $line,
                ?int $ingestId = null
            ): void {
            }

            public function latestForHost(int $hostId): ?array
            {
                return null;
            }

            public function recent(int $limit = 50): array
            {
                return [];
            }

            public function topHost(): ?array
            {
                return null;
            }

            public function dailyTotalsSince(string $startIso): array
            {
                return [];
            }
        };

        $tokenUsageIngests = new class() extends TokenUsageIngestRepository {
            public function __construct()
            {
            }

            public function record(?int $hostId, int $entries, array $totals, ?float $cost, ?string $payload, ?string $clientIp = null): array
            {
                return [
                    'id' => 0,
                    'host_id' => $hostId,
                    'entries' => $entries,
                    'total' => $totals['total'] ?? null,
                    'input' => $totals['input'] ?? null,
                    'output' => $totals['output'] ?? null,
                    'cached' => $totals['cached'] ?? null,
                    'reasoning' => $totals['reasoning'] ?? null,
                    'cost' => $cost,
                    'client_ip' => $clientIp,
                    'payload' => $payload,
                    'created_at' => gmdate(DATE_ATOM),
                ];
            }
        };

        $pricing = new class() extends PricingService {
            public function __construct()
            {
            }

            public function defaultModel(): string
            {
                return 'gpt-5.4';
            }

            public function latestPricing(string $model, bool $force = false): array
            {
                return [
                    'model' => $model,
                    'currency' => 'USD',
                    'input_price_per_1k' => 0.0,
                    'output_price_per_1k' => 0.0,
                    'cached_price_per_1k' => 0.0,
                ];
            }

            public function calculateCost(array $pricing, array $tokens): float
            {
                return 0.0;
            }
        };

        $versions = new class() extends VersionRepository {
            public function __construct()
            {
            }

            public function get(string $key): ?string
            {
                return null;
            }

            public function getWithMetadata(string $key): ?array
            {
                if ($key === 'client_available') {
                    return [
                        'version' => '0.99.0',
                        'updated_at' => gmdate(DATE_ATOM),
                    ];
                }
                return null;
            }

            public function getFlag(string $key, bool $default = false): bool
            {
                return $default;
            }
        };

        $wrapper = new class() extends WrapperService {
            public function __construct()
            {
            }

            public function metadata(string $engine = \App\Support\Engine::CODEX): array
            {
                return [];
            }

            public function ensureSeeded(string $engine = \App\Support\Engine::CODEX): void
            {
            }

            public function bakedForHost(array $host, string $baseUrl, ?string $caFile = null, string $engine = \App\Support\Engine::CODEX): array
            {
                return [
                    'version' => null,
                    'sha256' => null,
                    'size_bytes' => null,
                    'updated_at' => null,
                    'url' => '/wrapper/download',
                    'content' => null,
                ];
            }
        };

        $service = new AuthService(
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
            null
        );

        $response = $service->handleAuth(
            [
                'command' => 'retrieve',
                'last_refresh' => '2025-11-21T00:00:00Z',
                'digest' => str_repeat('b', 64),
            ],
            $host,
            '1.0.0',
            '2025.11.22-6',
            'http://api'
        );

        $snapshot = $response['versions'] ?? null;
        $this->assertIsArray($snapshot);
        $this->assertSame('0.114.0', $snapshot['client_version'] ?? null);
        $this->assertSame('locked', $snapshot['client_version_source'] ?? null);
        $this->assertNull($snapshot['client_version_checked_at'] ?? null);
        $this->assertFalse($snapshot['client_version_enforce_exact'] ?? true);
    }

    public function testHostOverrideKeepsHigherVersionExact(): void
    {
        $host = [
            'id' => 1,
            'fqdn' => 'host.test',
            'status' => 'active',
            'secure' => 1,
            'vip' => 0,
            'api_calls' => 0,
            'client_version_override' => '0.120.0',
        ];

        $hosts = new class($host) extends HostRepository {
            public array $host;

            public function __construct(array $host)
            {
                $this->host = $host;
            }

            public function updateClientVersions(int $hostId, string $clientVersion, ?string $wrapperVersion): void
            {
                $this->host['client_version'] = $clientVersion;
                $this->host['wrapper_version'] = $wrapperVersion;
            }

            public function incrementApiCalls(int $hostId, int $by = 1): void
            {
                $this->host['api_calls'] = ($this->host['api_calls'] ?? 0) + $by;
            }

            public function findById(int $id): ?array
            {
                return $this->host;
            }

            public function updateSyncState(int $hostId, string $lastRefresh, string $authDigest): void
            {
                $this->host['last_refresh'] = $lastRefresh;
                $this->host['auth_digest'] = $authDigest;
            }

            public function all(): array
            {
                return [$this->host];
            }
        };

        $payloads = new class() extends AuthPayloadRepository {
            public function __construct()
            {
            }

            public function findByIdWithEntries(int $id, ?string $engine = null): ?array
            {
                return null;
            }

            public function latest(string $engine = 'codex'): ?array
            {
                return null;
            }
        };

        $hostStates = new class() extends HostAuthStateRepository {
            public function __construct()
            {
            }

            public function upsert(int $hostId, int $payloadId, string $digest, string $engine = 'codex'): void
            {
            }
        };

        $digests = new class() extends HostAuthDigestRepository {
            public function __construct()
            {
            }

            public function recentDigests(int $hostId, int $limit = 3, string $engine = 'codex'): array
            {
                return [];
            }

            public function rememberDigests(int $hostId, array $digests, int $retain = 3, string $engine = 'codex'): void
            {
            }
        };

        $hostUsers = new class() extends HostUserRepository {
            public function __construct()
            {
            }

            public function record(int $hostId, string $username, ?string $hostname = null): void
            {
            }

            public function listByHost(int $hostId): array
            {
                return [];
            }

            public function deleteByHostId(int $hostId): void
            {
            }
        };

        $logs = new class() extends LogRepository {
            public function __construct()
            {
            }

            public function log(?int $hostId, string $action, array $details = []): void
            {
            }
        };

        $tokenUsages = new class() extends TokenUsageRepository {
            public function __construct()
            {
            }

            public function totals(?int $hostId = null): array
            {
                return [
                    'total' => 0,
                    'input' => 0,
                    'output' => 0,
                    'cached' => 0,
                    'reasoning' => 0,
                    'cost' => 0.0,
                    'events' => 0,
                ];
            }

            public function totalsForRange(string $startIso, string $endIso): array
            {
                return $this->totals();
            }

            public function totalsForHostRange(int $hostId, string $startIso, string $endIso): array
            {
                return $this->totals();
            }

            public function record(
                ?int $hostId,
                ?int $total,
                ?int $input,
                ?int $output,
                ?int $cached,
                ?int $reasoning,
                ?float $cost,
                ?string $model,
                ?string $line,
                ?int $ingestId = null
            ): void {
            }

            public function latestForHost(int $hostId): ?array
            {
                return null;
            }

            public function recent(int $limit = 50): array
            {
                return [];
            }

            public function topHost(): ?array
            {
                return null;
            }

            public function dailyTotalsSince(string $startIso): array
            {
                return [];
            }
        };

        $tokenUsageIngests = new class() extends TokenUsageIngestRepository {
            public function __construct()
            {
            }
        };

        $pricing = $this->createMock(PricingService::class);
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getWithMetadata')->willReturnCallback(static function (string $name): ?array {
            if ($name === 'client_available') {
                return ['version' => '0.114.0', 'updated_at' => '2025-11-22T00:00:00Z'];
            }

            return null;
        });
        $versions->method('get')->willReturnCallback(static function (string $name): ?string {
            return match ($name) {
                'canonical_payload_id' => null,
                'quota_limit_percent' => '100',
                'quota_week_partition' => '0',
                default => null,
            };
        });
        $versions->method('getFlag')->willReturnCallback(static function (string $name, bool $default = false): bool {
            return $default;
        });

        $wrapper = new class() extends WrapperService {
            public function __construct()
            {
            }

            public function metadata(string $engine = \App\Support\Engine::CODEX): array
            {
                return [
                    'version' => null,
                    'sha256' => null,
                    'size_bytes' => null,
                    'updated_at' => null,
                    'url' => '/wrapper/download',
                ];
            }

            public function updateContent(string $content): array
            {
                return [];
            }

            public function bakedForHost(array $host, string $baseUrl, ?string $caFile = null, string $engine = \App\Support\Engine::CODEX): array
            {
                return [
                    'version' => null,
                    'sha256' => null,
                    'size_bytes' => null,
                    'updated_at' => null,
                    'url' => '/wrapper/download',
                    'content' => null,
                ];
            }
        };

        $service = new AuthService(
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
            null
        );

        $response = $service->handleAuth(
            [
                'command' => 'retrieve',
                'last_refresh' => '2025-11-21T00:00:00Z',
                'digest' => str_repeat('b', 64),
            ],
            $host,
            '1.0.0',
            '2025.11.22-6',
            'http://api'
        );

        $snapshot = $response['versions'] ?? null;
        $this->assertIsArray($snapshot);
        $this->assertSame('0.120.0', $snapshot['client_version'] ?? null);
        $this->assertSame('locked', $snapshot['client_version_source'] ?? null);
        $this->assertNull($snapshot['client_version_checked_at'] ?? null);
        $this->assertTrue($snapshot['client_version_enforce_exact'] ?? false);
    }
}
