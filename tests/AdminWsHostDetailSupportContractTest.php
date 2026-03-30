<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminWsHostDetailSupportContractTest extends TestCase
{
    public function testAdminWsServerHandlesHostDetailSupportRequests(): void
    {
        $php = file_get_contents(__DIR__ . '/../scripts/admin-ws.php');
        $this->assertIsString($php);

        $this->assertStringContainsString("function buildHostDetailSupportPayload", $php);
        $this->assertStringContainsString("function buildRunnerSupportPayload", $php);
        $this->assertStringContainsString("'host-detail-support' => [", $php);
        $this->assertStringContainsString("'kind' => 'response'", $php);
        $this->assertStringContainsString("'kind' => 'error'", $php);
        $this->assertStringContainsString("buildRunnerSupportPayload(\$logs)", $php);
        $this->assertStringContainsString("\$agents->adminFetch()", $php);
    }
}
