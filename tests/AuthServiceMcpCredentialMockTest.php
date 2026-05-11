<?php

declare(strict_types=1);

use App\Exceptions\HttpException;
use App\Repositories\AuthPayloadRepository;
use App\Repositories\HostAuthDigestRepository;
use App\Repositories\HostAuthStateRepository;
use App\Repositories\HostRepository;
use App\Repositories\HostUserRepository;
use App\Repositories\LogRepository;
use App\Repositories\McpSessionTokenRepository;
use App\Repositories\TokenUsageIngestRepository;
use App\Repositories\TokenUsageRepository;
use App\Repositories\VersionRepository;
use App\Services\AuthService;
use App\Services\WrapperService;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthServiceMcpCredentialMockTest extends TestCase
{
    public function testAuthenticateMcpCredentialAcceptsValidEphemeralTokenWithoutSodiumDependency(): void
    {
        $hosts = $this->createMock(HostRepository::class);
        $hosts->method('all')->willReturn([]);
        $hosts->method('findInactiveBefore')->willReturn([]);
        $hosts->method('findUnprovisionedBefore')->willReturn([]);
        $hosts->method('findExpiredBefore')->willReturn([]);
        $hosts->method('findById')->with(12)->willReturn([
            'id' => 12,
            'fqdn' => 'insecure.test',
            'status' => 'active',
            'secure' => 0,
        ]);

        $tokens = $this->createMock(McpSessionTokenRepository::class);
        $tokens->expects($this->once())->method('deleteExpired');
        $tokens->expects($this->once())->method('findByToken')->with('mcp_valid')->willReturn([
            'id' => 7,
            'host_id' => 12,
            'expires_at' => gmdate(DATE_ATOM, time() + 900),
        ]);
        $tokens->expects($this->once())->method('touch')->with(7);

        $service = $this->makeService($hosts, $tokens);

        $resolved = $service->authenticateMcpCredential('mcp_valid', '203.0.113.10');

        self::assertSame(12, $resolved['id']);
        self::assertSame('insecure.test', $resolved['fqdn']);
    }

    public function testAuthenticateMcpCredentialRejectsExpiredEphemeralTokenWithoutSodiumDependency(): void
    {
        $hosts = $this->createMock(HostRepository::class);
        $hosts->method('all')->willReturn([]);
        $hosts->method('findInactiveBefore')->willReturn([]);
        $hosts->method('findUnprovisionedBefore')->willReturn([]);
        $hosts->method('findExpiredBefore')->willReturn([]);

        $tokens = $this->createMock(McpSessionTokenRepository::class);
        $tokens->expects($this->once())->method('deleteExpired');
        $tokens->expects($this->once())->method('findByToken')->with('mcp_expired')->willReturn([
            'id' => 8,
            'host_id' => 12,
            'expires_at' => gmdate(DATE_ATOM, time() - 60),
        ]);
        $tokens->expects($this->never())->method('touch');

        $service = $this->makeService($hosts, $tokens);

        $this->expectException(HttpException::class);
        $this->expectExceptionMessage('MCP credential expired');

        $service->authenticateMcpCredential('mcp_expired', '203.0.113.10');
    }

    private function makeService(HostRepository $hosts, McpSessionTokenRepository $tokens): AuthService
    {
        return new AuthService(
            $hosts,
            $this->createMock(AuthPayloadRepository::class),
            $this->createMock(HostAuthStateRepository::class),
            $this->createMock(HostAuthDigestRepository::class),
            $this->createMock(HostUserRepository::class),
            $this->createMock(LogRepository::class),
            $this->createMock(TokenUsageRepository::class),
            $this->createMock(TokenUsageIngestRepository::class),
            $this->createMock(VersionRepository::class),
            $this->createMock(WrapperService::class),
            null,
            null,
            null,
            null,
            null,
            null,
            $tokens
        );
    }
}
