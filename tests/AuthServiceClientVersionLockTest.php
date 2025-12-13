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

final class AuthServiceClientVersionLockTest extends TestCase
{
    public function testVersionSummaryUsesLockedClientVersion(): void
    {
        $hosts = $this->createMock(HostRepository::class);
        $hosts->method('all')->willReturn([]);

        $payloads = $this->createMock(AuthPayloadRepository::class);
        $hostStates = $this->createMock(HostAuthStateRepository::class);
        $digests = $this->createMock(HostAuthDigestRepository::class);
        $hostUsers = $this->createMock(HostUserRepository::class);
        $logs = $this->createMock(LogRepository::class);
        $tokenUsages = $this->createMock(TokenUsageRepository::class);
        $tokenUsageIngests = $this->createMock(TokenUsageIngestRepository::class);
        $pricingService = $this->createMock(PricingService::class);

        $versions = $this->createMock(VersionRepository::class);
        $versions->method('getWithMetadata')->willReturnCallback(static function (string $name): ?array {
            if ($name === 'client_version_lock') {
                return ['version' => 'rust-v0.61.0', 'updated_at' => '2025-12-13T00:00:00Z'];
            }
            return null;
        });
        $versions->method('getFlag')->willReturnCallback(static function (string $name, bool $default = false): bool {
            return $default;
        });
        $versions->method('get')->willReturn(null);

        $wrapperService = $this->createMock(WrapperService::class);
        $wrapperService->method('metadata')->willReturn([
            'version' => '2025.12.13-02',
            'sha256' => null,
            'url' => null,
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
            $pricingService,
            $versions,
            $wrapperService
        );

        $summary = $service->versionSummary();

        $this->assertSame('0.61.0', $summary['client_version']);
        $this->assertSame('locked', $summary['client_version_source']);
        $this->assertSame('2025-12-13T00:00:00Z', $summary['client_version_checked_at']);
    }
}

