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
        $this->assertStringContainsString('OVERVIEW_HOST_LIVE_ACTIONS', $js);
        $this->assertStringContainsString('OVERVIEW_HOST_LIVE_PREFIXES', $js);
        $this->assertStringContainsString('SETTINGS_GENERAL_LIVE_ACTIONS', $js);
        $this->assertStringContainsString('WS_UNKNOWN_ACTION_FALLBACK_DOMAINS', $js);
        $this->assertStringContainsString('WS_UNKNOWN_ACTION_FALLBACK_DELAY_MS', $js);
        $this->assertStringContainsString('dashboard-charts', $js);
        $this->assertStringContainsString('DASHBOARD_CHART_LIVE_ACTIONS', $js);
        $this->assertStringContainsString('token.usage', $js);
    }
}
