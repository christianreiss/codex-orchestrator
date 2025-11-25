<?php

declare(strict_types=1);

use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\LogRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

class InMemoryHostRepository extends HostRepository
{
    public array $host;

    public function __construct(array $host)
    {
        $this->host = $host;
    }

    public function updateClientVersions(int $hostId, string $clientVersion, ?string $wrapperVersion): void
    {
        $this->host['client_version'] = $clientVersion;
        $this->host['wrapper_version'] = null;
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

class InMemoryAuthPayloadRepository extends AuthPayloadRepository
{
    public function __construct(private readonly array $payload)
    {
    }

    public function findByIdWithEntries(int $id): ?array
    {
        return $this->payload['id'] === $id ? $this->payload : null;
    }

    public function latest(): ?array
    {
        return $this->payload;
    }
}

class InMemoryHostAuthDigestRepository extends HostAuthDigestRepository
{
    private array $digests = [];

    public function __construct()
    {
    }

    public function recentDigests(int $hostId, int $limit = 3): array
    {
        return array_slice($this->digests, 0, $limit);
    }

    public function rememberDigests(int $hostId, array $digests, int $retain = 3): void
    {
        $merged = array_values(array_unique(array_merge($digests, $this->digests)));
        $this->digests = array_slice($merged, 0, $retain);
    }
}

class NullHostAuthStateRepository extends HostAuthStateRepository
{
    public function __construct()
    {
    }

    public function upsert(int $hostId, int $payloadId, string $digest): void
    {
        // no-op for test
    }
}

class NullLogRepository extends LogRepository
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

class NullTokenUsageRepository extends TokenUsageRepository
{
    public function __construct()
    {
    }
}

class InMemoryVersionRepository extends VersionRepository
{
    private array $store;

    public function __construct(array $store)
    {
        $this->store = $store;
    }

    public function get(string $key): ?string
    {
        $value = $this->store[$key] ?? null;
        return is_string($value) ? $value : null;
    }

    public function getWithMetadata(string $key): ?array
    {
        if (!isset($this->store[$key])) {
            return null;
        }
        return [
            'version' => (string) $this->store[$key],
            'updated_at' => gmdate(DATE_ATOM),
        ];
    }

    public function set(string $key, string $value): void
    {
        $this->store[$key] = $value;
    }

    public function all(): array
    {
        return $this->store;
    }
}

class StubWrapperService extends WrapperService
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

    public function replaceFromUpload(string $tmpPath, string $version, ?string $expectedSha, bool $isUploadedFile = false): array
    {
        return [];
    }

    public function contentPath(): string
    {
        return '';
    }

    public function bakedForHost(array $host, string $baseUrl, ?string $caFile = null): array
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
}

final class AuthServiceUploadRequiredTest extends TestCase
{
    public function testRetrieveRespondsWithUploadRequiredWhenClientIsNewer(): void
    {
        $canonicalAuth = [
            'last_refresh' => '2025-11-20T00:00:00Z',
            'auths' => [
                'api.openai.com' => [
                    'token' => 'tok-1234567890abcdef-XYZ987654',
                    'token_type' => 'bearer',
                ],
            ],
        ];
        $canonicalDigest = hash('sha256', json_encode($canonicalAuth, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
        $canonicalPayload = [
            'id' => 99,
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

        $host = [
            'id' => 1,
            'fqdn' => 'host.test',
            'status' => 'active',
            'api_calls' => 0,
        ];

        $service = new AuthService(
            new InMemoryHostRepository($host),
            new InMemoryAuthPayloadRepository($canonicalPayload),
            new NullHostAuthStateRepository(),
            new InMemoryHostAuthDigestRepository(),
            new NullLogRepository(),
            new NullTokenUsageRepository(),
            new InMemoryVersionRepository(['canonical_payload_id' => 99]),
            new StubWrapperService()
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

        $this->assertSame('upload_required', $response['status'] ?? null);
        $this->assertSame('store', $response['action'] ?? null);
        $this->assertSame($canonicalDigest, $response['canonical_digest'] ?? null);
    }
}
