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
require_once __DIR__ . '/ContractSchemaValidator.php';

final class ContractHostRepository extends HostRepository
{
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
        $this->host['api_calls'] = ((int) ($this->host['api_calls'] ?? 0)) + $by;
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
}

final class ContractAuthPayloadRepository extends AuthPayloadRepository
{
    public ?array $latestPayload;
    private int $nextId = 100;

    public function __construct(?array $latestPayload)
    {
        $this->latestPayload = $latestPayload;
    }

    public function latest(): ?array
    {
        return $this->latestPayload;
    }

    public function findByIdWithEntries(int $id): ?array
    {
        if ($this->latestPayload === null) {
            return null;
        }

        return ((int) ($this->latestPayload['id'] ?? 0) === $id) ? $this->latestPayload : null;
    }

    public function create(string $lastRefresh, string $sha256, ?int $sourceHostId, array $entries, ?string $body = null): array
    {
        $row = [
            'id' => $this->nextId++,
            'last_refresh' => $lastRefresh,
            'sha256' => $sha256,
            'source_host_id' => $sourceHostId,
            'entries' => $entries,
            'body' => $body,
            'created_at' => gmdate(DATE_ATOM),
        ];
        $this->latestPayload = $row;

        return $row;
    }
}

final class ContractHostAuthStateRepository extends HostAuthStateRepository
{
    public function __construct()
    {
    }

    public function upsert(int $hostId, int $payloadId, string $digest): void
    {
    }
}

final class ContractHostAuthDigestRepository extends HostAuthDigestRepository
{
    /** @var list<string> */
    private array $digests = [];

    public function __construct()
    {
    }

    public function rememberDigests(int $hostId, array $digests, int $retain = 3): void
    {
        $merged = array_values(array_unique(array_merge($digests, $this->digests)));
        $this->digests = array_slice($merged, 0, $retain);
    }

    public function recentDigests(int $hostId, int $limit = 3): array
    {
        return array_slice($this->digests, 0, $limit);
    }
}

final class ContractHostUserRepository extends HostUserRepository
{
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
}

final class ContractLogRepository extends LogRepository
{
    public function __construct()
    {
    }

    public function log(?int $hostId, string $action, array $details = []): void
    {
    }
}

final class ContractTokenUsageRepository extends TokenUsageRepository
{
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
        return [
            'total' => 1500,
            'input' => 1100,
            'output' => 350,
            'cached' => 30,
            'reasoning' => 20,
            'cost' => 0.50,
            'events' => 5,
        ];
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
}

final class ContractTokenUsageIngestRepository extends TokenUsageIngestRepository
{
    private int $nextId = 1;

    public function __construct()
    {
    }

    public function record(?int $hostId, int $entries, array $totals, ?float $cost, ?string $payload, ?string $clientIp = null): array
    {
        return [
            'id' => $this->nextId++,
            'host_id' => $hostId,
            'entries' => $entries,
            'total' => $totals['total'] ?? null,
            'input' => $totals['input'] ?? null,
            'output' => $totals['output'] ?? null,
            'cached' => $totals['cached'] ?? null,
            'reasoning' => $totals['reasoning'] ?? null,
            'cost' => $cost,
            'payload' => $payload,
            'client_ip' => $clientIp,
            'created_at' => gmdate(DATE_ATOM),
        ];
    }
}

final class ContractPricingService extends PricingService
{
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
            'input_price_per_1k' => 1.0,
            'output_price_per_1k' => 2.0,
            'cached_price_per_1k' => 0.1,
        ];
    }

    public function calculateCost(array $pricing, array $tokens): float
    {
        $input = ((float) ($tokens['input'] ?? 0)) / 1000.0;
        $output = ((float) ($tokens['output'] ?? 0)) / 1000.0;
        $cached = ((float) ($tokens['cached'] ?? 0)) / 1000.0;

        return round(
            ($input * (float) ($pricing['input_price_per_1k'] ?? 0)) +
            ($output * (float) ($pricing['output_price_per_1k'] ?? 0)) +
            ($cached * (float) ($pricing['cached_price_per_1k'] ?? 0)),
            6
        );
    }
}

final class ContractVersionRepository extends VersionRepository
{
    /** @var array<string, string> */
    private array $values;

    public function __construct(array $values = [])
    {
        $this->values = $values;
    }

    public function get(string $name): ?string
    {
        return $this->values[$name] ?? null;
    }

    public function set(string $name, string $version): void
    {
        $this->values[$name] = $version;
    }

    public function getFlag(string $name, bool $default = false): bool
    {
        if (!array_key_exists($name, $this->values)) {
            return $default;
        }

        $value = strtolower(trim((string) $this->values[$name]));
        if (in_array($value, ['1', 'true', 'yes', 'on'], true)) {
            return true;
        }
        if (in_array($value, ['0', 'false', 'no', 'off'], true)) {
            return false;
        }

        return $default;
    }

    public function getWithMetadata(string $name): ?array
    {
        if (!array_key_exists($name, $this->values)) {
            return null;
        }

        return [
            'name' => $name,
            'version' => $this->values[$name],
            'updated_at' => gmdate(DATE_ATOM),
        ];
    }
}

final class AuthServiceContractResponsesTest extends TestCase
{
    private array $authRetrieveSchema;
    private array $authStoreSchema;
    private array $versionsSchema;
    private array $usageSchema;

    protected function setUp(): void
    {
        $this->authRetrieveSchema = $this->loadJson(__DIR__ . '/../docs/contracts/auth-retrieve.schema.json');
        $this->authStoreSchema = $this->loadJson(__DIR__ . '/../docs/contracts/auth-store.schema.json');
        $this->versionsSchema = $this->loadJson(__DIR__ . '/../docs/contracts/versions.schema.json');
        $this->usageSchema = $this->loadJson(__DIR__ . '/../docs/contracts/usage-ingest.schema.json');
    }

    public function testRetrieveOutdatedResponseMatchesContractSchema(): void
    {
        $canonicalAuth = [
            'last_refresh' => '2026-02-22T10:00:00Z',
            'auths' => [
                'api.openai.com' => [
                    'token' => 'sk-contract-canonical-token-12345678901234567890',
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $canonicalBody = json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        self::assertIsString($canonicalBody);
        $canonicalPayload = [
            'id' => 7,
            'last_refresh' => '2026-02-22T10:00:00Z',
            'sha256' => hash('sha256', $canonicalBody),
            'source_host_id' => 1,
            'body' => $canonicalBody,
            'created_at' => '2026-02-22T10:00:00Z',
        ];

        [$service, $hostRepo] = $this->buildService($canonicalPayload);

        $result = $service->handleAuth(
            [
                'command' => 'retrieve',
                'last_refresh' => '2026-02-22T09:00:00Z',
                'digest' => hash('sha256', '{"last_refresh":"2026-02-22T09:00:00Z","auths":{}}'),
            ],
            $hostRepo->host,
            '0.101.0',
            '2026.02.22-01',
            'https://fleet.example.com',
            true
        );

        $this->assertSame('outdated', $result['status'] ?? null);
        $response = [
            'status' => 'ok',
            'data' => array_merge($result, ['chatgpt_usage' => null]),
        ];

        $errors = ContractSchemaValidator::validate($response, $this->authRetrieveSchema);
        $this->assertSame([], $errors, implode("\n", $errors));
    }

    public function testStoreUpdatedResponseMatchesContractSchema(): void
    {
        [$service, $hostRepo] = $this->buildService(null);

        $result = $service->handleAuth(
            [
                'command' => 'store',
                'auth' => [
                    'last_refresh' => '2026-02-22T10:30:00Z',
                    'auths' => [
                        'api.openai.com' => [
                            'token' => 'sk-contract-upload-token-12345678901234567890',
                            'token_type' => 'bearer',
                        ],
                    ],
                ],
            ],
            $hostRepo->host,
            '0.101.0',
            '2026.02.22-01',
            'https://fleet.example.com',
            true
        );

        $this->assertSame('updated', $result['status'] ?? null);
        $response = [
            'status' => 'ok',
            'data' => array_merge($result, ['chatgpt_usage' => null]),
        ];

        $errors = ContractSchemaValidator::validate($response, $this->authStoreSchema);
        $this->assertSame([], $errors, implode("\n", $errors));
    }

    public function testVersionSummaryMatchesContractSchema(): void
    {
        [$service] = $this->buildService(null);
        $response = [
            'status' => 'ok',
            'data' => $service->versionSummary(),
        ];

        $errors = ContractSchemaValidator::validate($response, $this->versionsSchema);
        $this->assertSame([], $errors, implode("\n", $errors));
    }

    public function testUsageResponseMatchesContractSchema(): void
    {
        [$service, $hostRepo] = $this->buildService(null);
        $data = $service->recordTokenUsage(
            $hostRepo->host,
            [
                'line' => 'Token usage: total=100 input=70 output=30',
                'total' => 100,
                'input' => 70,
                'output' => 30,
                'cached' => 0,
                'reasoning' => 0,
                'model' => 'gpt-5.1',
            ],
            '203.0.113.10'
        );

        $response = [
            'status' => 'ok',
            'data' => $data,
        ];

        $errors = ContractSchemaValidator::validate($response, $this->usageSchema);
        $this->assertSame([], $errors, implode("\n", $errors));
    }

    public function testUsageCostIsNullWhenOnlyTotalTokensAreKnown(): void
    {
        [$service, $hostRepo] = $this->buildService(null);
        $data = $service->recordTokenUsage(
            $hostRepo->host,
            [
                'line' => 'tokens used: total=13,841',
                'total' => 13841,
            ],
            '203.0.113.10'
        );

        $this->assertNull($data['cost'] ?? null);
        $this->assertSame(13841, $data['total'] ?? null);
        $this->assertCount(1, $data['usages'] ?? []);
        $this->assertNull($data['usages'][0]['cost'] ?? null);
        $this->assertSame(13841, $data['usages'][0]['total'] ?? null);
    }

    /**
     * @return array{0:AuthService, 1:ContractHostRepository}
     */
    private function buildService(?array $canonicalPayload): array
    {
        $host = [
            'id' => 1,
            'fqdn' => 'host-a.example.com',
            'status' => 'active',
            'last_refresh' => null,
            'updated_at' => '2026-02-22T10:00:00Z',
            'expires_at' => null,
            'client_version' => '0.101.0',
            'client_version_override' => null,
            'wrapper_version' => '2026.02.22-01',
            'agents_document_id_override' => null,
            'api_calls' => 0,
            'allow_roaming_ips' => 0,
            'secure' => 1,
            'vip' => 0,
            'insecure_enabled_until' => null,
            'insecure_grace_until' => null,
            'insecure_window_minutes' => null,
            'force_ipv4' => 0,
            'lane_preference' => 'normal',
            'model_override' => null,
            'reasoning_effort_override' => null,
        ];

        $hosts = new ContractHostRepository($host);
        $payloads = new ContractAuthPayloadRepository($canonicalPayload);
        $hostStates = new ContractHostAuthStateRepository();
        $digests = new ContractHostAuthDigestRepository();
        $hostUsers = new ContractHostUserRepository();
        $logs = new ContractLogRepository();
        $tokenUsages = new ContractTokenUsageRepository();
        $tokenUsageIngests = new ContractTokenUsageIngestRepository();
        $pricing = new ContractPricingService();
        $versions = new ContractVersionRepository([
            'canonical_payload_id' => $canonicalPayload !== null ? (string) ($canonicalPayload['id'] ?? '0') : '',
            'quota_hard_fail' => '1',
            'quota_limit_percent' => '90',
            'quota_week_partition' => '7',
            'cdx_silent' => '0',
            'runner_state' => 'ok',
            'runner_last_ok' => '2026-02-22T09:59:00Z',
            'runner_last_fail' => '',
            'runner_last_check' => '2026-02-22T09:59:00Z',
            'client_available' => '0.101.0',
        ]);

        $wrapper = $this->createMock(WrapperService::class);
        $wrapper->method('metadata')->willReturn([
            'version' => '2026.02.22-01',
            'sha256' => 'a4dfab14ed740bb7f4f3f3f040f8a337d66a5934a5ff7ce5f0a7e7f1f12ec401',
            'url' => '/wrapper/download',
        ]);
        $wrapper->method('bakedForHost')->willReturn([
            'version' => '2026.02.22-01',
            'sha256' => 'a4dfab14ed740bb7f4f3f3f040f8a337d66a5934a5ff7ce5f0a7e7f1f12ec401',
            'url' => '/wrapper/download',
            'content' => '#!/usr/bin/env bash',
        ]);

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
            null,
            null
        );

        return [$service, $hosts];
    }

    private function loadJson(string $path): array
    {
        $json = @file_get_contents($path);
        $this->assertIsString($json, 'Expected to read JSON file: ' . $path);

        $decoded = json_decode($json, true);
        $this->assertIsArray($decoded, 'Expected valid JSON object in: ' . $path);

        return $decoded;
    }
}
