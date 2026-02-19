<?php

declare(strict_types=1);

use App\Exceptions\HttpException;
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

class InsecureSessionHostRepository extends HostRepository
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
}

class InsecureSessionAuthPayloadRepository extends AuthPayloadRepository
{
    public ?array $payload = null;

    public function __construct()
    {
    }

    public function create(string $lastRefresh, string $sha256, ?int $sourceHostId, array $entries, ?string $extrasJson = null): array
    {
        $this->payload = [
            'id' => 1,
            'last_refresh' => $lastRefresh,
            'sha256' => $sha256,
            'source_host_id' => $sourceHostId,
            'entries' => $entries,
        ];

        return $this->payload;
    }

    public function latest(): ?array
    {
        return $this->payload;
    }

    public function findByIdWithEntries(int $id): ?array
    {
        return $this->payload;
    }
}

class InsecureSessionHostAuthStateRepository extends HostAuthStateRepository
{
    public function __construct()
    {
    }

    public function upsert(int $hostId, int $payloadId, string $digest): void
    {
        // no-op
    }
}

class InsecureSessionHostAuthDigestRepository extends HostAuthDigestRepository
{
    public function __construct()
    {
    }

    public function recentDigests(int $hostId, int $limit = 3): array
    {
        return [];
    }

    public function rememberDigests(int $hostId, array $digests, int $retain = 3): void
    {
        // no-op
    }
}

class InsecureSessionHostUserRepository extends HostUserRepository
{
    public function __construct()
    {
    }

    public function record(int $hostId, string $username, ?string $hostname = null): void
    {
        // no-op
    }

    public function listByHost(int $hostId): array
    {
        return [];
    }

    public function deleteByHostId(int $hostId): void
    {
        // no-op
    }
}

class InsecureSessionLogRepository extends LogRepository
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

class InsecureSessionTokenUsageRepository extends TokenUsageRepository
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
        return $this->totals();
    }

    public function totalsByHost(): array
    {
        return [];
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
        // no-op
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

class InsecureSessionTokenUsageIngestRepository extends TokenUsageIngestRepository
{
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
}

class InsecureSessionPricingService extends PricingService
{
    public function __construct()
    {
    }

    public function defaultModel(): string
    {
        return 'gpt-5.1';
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
}

class InsecureSessionVersionRepository extends VersionRepository
{
    public function __construct()
    {
    }

    public function get(string $key): ?string
    {
        return null;
    }

    public function getWithMetadata(string $key): ?array
    {
        return null;
    }

    public function getFlag(string $key, bool $default = false): bool
    {
        return $default;
    }

    public function set(string $key, string $value): void
    {
    }

    public function all(): array
    {
        return [];
    }
}

class InsecureSessionWrapperService extends WrapperService
{
    public function __construct()
    {
    }

    public function metadata(): array
    {
        return [];
    }

    public function ensureSeeded(): void
    {
    }
}

final class AuthServiceInsecurePostRunStoreTest extends TestCase
{
    public function testStoreAllowedWhenInsecureWindowClosedWithoutSessionHint(): void
    {
        $now = time();
        $host = [
            'id' => 1,
            'fqdn' => 'insecure.long.run',
            'status' => 'active',
            'secure' => 0,
            'api_calls' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, $now - 1200),
            'insecure_grace_until' => gmdate(DATE_ATOM, $now - 600),
        ];

        [$service, $logs] = $this->buildService($host);

        $authPayload = [
            'last_refresh' => gmdate(DATE_ATOM, $now - 60),
            'auths' => [
                'api.openai.com' => [
                    'token' => 'tok-1234567890abcdef-XYZ987654',
                    'token_type' => 'bearer',
                ],
            ],
        ];

        $response = $service->handleAuth(
            [
                'command' => 'store',
                'auth' => $authPayload,
            ],
            $host,
            '1.0.0',
            '2026.01.26-01',
            null,
            true
        );

        self::assertSame('updated', $response['status'] ?? null);
        $actions = array_map(static fn (array $event): string => (string) ($event[1] ?? ''), $logs->events);
        self::assertContains('auth.store', $actions);
        self::assertNotContains('auth.insecure.post_run_store', $actions);
        self::assertNotContains('auth.insecure.denied', $actions);
    }

    public function testRetrieveStillDeniedWhenInsecureWindowClosed(): void
    {
        $now = time();
        $host = [
            'id' => 1,
            'fqdn' => 'insecure.long.run',
            'status' => 'active',
            'secure' => 0,
            'api_calls' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, $now - 1200),
            'insecure_grace_until' => gmdate(DATE_ATOM, $now - 600),
        ];

        [$service] = $this->buildService($host);

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('Insecure host API access disabled');

        $service->handleAuth(
            [
                'command' => 'retrieve',
                'last_refresh' => gmdate(DATE_ATOM, $now - 60),
                'digest' => str_repeat('a', 64),
            ],
            $host,
            '1.0.0',
            '2026.01.26-01',
            null,
            true
        );
    }

    private function buildService(array $host): array
    {
        $hosts = new InsecureSessionHostRepository($host);
        $payloads = new InsecureSessionAuthPayloadRepository();
        $hostStates = new InsecureSessionHostAuthStateRepository();
        $digests = new InsecureSessionHostAuthDigestRepository();
        $hostUsers = new InsecureSessionHostUserRepository();
        $logs = new InsecureSessionLogRepository();
        $tokenUsages = new InsecureSessionTokenUsageRepository();
        $tokenUsageIngests = new InsecureSessionTokenUsageIngestRepository();
        $pricing = new InsecureSessionPricingService();
        $versions = new InsecureSessionVersionRepository();
        $wrapper = new InsecureSessionWrapperService();

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

        return [$service, $logs];
    }
}
