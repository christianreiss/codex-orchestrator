<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardOverviewLiveUpdateTest extends TestCase
{
    public function testDashboardRefreshesOverviewOnWebsocketEvents(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('admin-ws-event', $js);
        $this->assertStringContainsString('actionDomainsForLiveRefresh', $js);
        $this->assertStringContainsString('emitAdminDataDirty', $js);
        $this->assertStringContainsString("api('/admin/hosts')", $js);
        $this->assertStringContainsString('shouldRefreshOverviewForAction', $js);
        $this->assertStringContainsString('token.usage', $js);
    }
}
