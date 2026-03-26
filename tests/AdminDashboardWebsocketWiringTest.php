<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminDashboardWebsocketWiringTest extends TestCase
{
    public function testAdminIndexLoadsDashboardAndWsScriptsInOrder(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $dashboardPos = strpos($html, '/admin/assets/dashboard.js');
        $logsPos = strpos($html, '/admin/assets/logs.js');
        $wsPos = strpos($html, '/admin/assets/admin-ws.js');

        $this->assertIsInt($dashboardPos);
        $this->assertIsInt($logsPos);
        $this->assertIsInt($wsPos);
        $this->assertGreaterThan($dashboardPos, $logsPos);
        $this->assertGreaterThan($logsPos, $wsPos);
    }

    public function testDashboardUnknownWsActionsStillRefreshOverviewAndHosts(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('if (action) {', $js);
        $this->assertStringContainsString('WS_UNKNOWN_ACTION_FALLBACK_DOMAINS', $js);
        $this->assertStringContainsString('WS_UNKNOWN_ACTION_FALLBACK_DELAY_MS', $js);
        $this->assertStringContainsString('scheduleLiveDataRefresh(WS_UNKNOWN_ACTION_FALLBACK_DOMAINS, WS_UNKNOWN_ACTION_FALLBACK_DELAY_MS);', $js);
    }

    public function testDashboardRingsBellForNewInsecureApprovalRequests(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('INSECURE_APPROVAL_BELL_COOLDOWN_MS = 5000', $js);
        $this->assertStringContainsString('async function ringInsecureApprovalBell()', $js);
        $this->assertStringContainsString('window.AudioContext || window.webkitAudioContext', $js);
        $this->assertStringContainsString('const queued = enqueueInsecureApproval({', $js);
        $this->assertStringContainsString('if (queued) {', $js);
        $this->assertStringContainsString('ringInsecureApprovalBell();', $js);
    }
}
