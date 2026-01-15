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

final class AuthServiceInsecureGraceStoreTest extends TestCase
{
    public function testStoreAllowedDuringGraceWhenWindowClosed(): void
    {
        $hosts = $this->createMock(HostRepository::class);
        $payloads = $this->createMock(AuthPayloadRepository::class);
        $hostStates = $this->createMock(HostAuthStateRepository::class);
        $digests = $this->createMock(HostAuthDigestRepository::class);
        $hostUsers = $this->createMock(HostUserRepository::class);
        $logs = $this->createMock(LogRepository::class);
        $tokenUsages = $this->createMock(TokenUsageRepository::class);
        $tokenUsageIngests = $this->createMock(TokenUsageIngestRepository::class);
        $pricing = $this->createMock(PricingService::class);
        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getWithMetadata')->willReturn(null);
        $versions->method('getFlag')->willReturn(false);
        $wrapper = $this->createMock(WrapperService::class);

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

        $host = [
            'id' => 1,
            'fqdn' => 'insecure.grace',
            'secure' => 0,
            'insecure_enabled_until' => gmdate(DATE_ATOM, time() - 60),
            'insecure_grace_until' => gmdate(DATE_ATOM, time() + 600),
        ];

        $result = $service->enforceInsecureWindow($host, 'store');

        self::assertSame($host['insecure_enabled_until'], $result['insecure_enabled_until'] ?? null);
    }
}
