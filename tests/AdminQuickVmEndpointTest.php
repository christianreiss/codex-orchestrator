<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminQuickVmEndpointTest extends TestCase
{
    public function testQuickRegisterRouteAndControllerAreWired(): void
    {
        $router = file_get_contents(__DIR__ . '/../public/index.php');
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php');
        self::assertIsString($router);
        self::assertIsString($controller);

        self::assertStringContainsString("#^/admin/hosts/quick-register$#", $router);
        self::assertStringContainsString('quickRegister(is_array($payload) ? $payload : [])', $router);
        self::assertStringContainsString('public function quickRegister(array $payload): void', $controller);
        self::assertStringContainsString('requireAdminCapability(AdminAuthService::CAP_HOSTS_MANAGE);', $controller);
    }

    public function testQuickRegisterCreatesInsecureTemporaryHostAndInstaller(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php');
        self::assertIsString($controller);

        self::assertStringContainsString('$engines = $this->normalizeEngineSelection($payload, true);', $controller);
        self::assertStringContainsString('$fqdn = $this->generateQuickHostName();', $controller);
        self::assertStringContainsString('$this->service->register($fqdn, false, $durationMinutes, $engines);', $controller);
        self::assertStringContainsString('$expiresAt = gmdate(DATE_ATOM, time() + 7200);', $controller);
        self::assertStringContainsString('$hostId = $this->requireHostId($host);', $controller);
        self::assertStringContainsString('$this->hostRepository->updateExpiresAt($hostId, $expiresAt);', $controller);
        self::assertStringContainsString('$this->hostRepository->updateVip($hostId, false);', $controller);
        self::assertStringContainsString('$this->hostRepository->updateCurlInsecure($hostId, false);', $controller);
        self::assertStringContainsString('$this->createInstallerResponseData($host, $hostPayload, $engines)', $controller);
    }

    public function testQuickRegisterUsesShortTmpHostnameAndRejectsMissingEngines(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php');
        self::assertIsString($controller);

        self::assertStringContainsString("sprintf('tmp-%s-%s', gmdate('Ymd-His'), bin2hex(random_bytes(3)))", $controller);
        self::assertStringContainsString('engines must contain at least one of:', $controller);
    }
}
