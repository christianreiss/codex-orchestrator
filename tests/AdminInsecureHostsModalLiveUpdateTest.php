<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsModalLiveUpdateTest extends TestCase
{
    public function testInsecureHostsModalTracksCountdownsAndWsRefresh(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('shouldRefreshInsecureModalForAction', $js);
        $this->assertStringContainsString('scheduleInsecureHostsModalRefresh', $js);
        $this->assertStringContainsString('data-countdown="host"', $js);
        $this->assertStringContainsString('data-countdown="domain"', $js);
        $this->assertStringContainsString('Active Windows (${activeCount})', $js);
        $this->assertStringContainsString('const activeHosts = items.filter((host) => hostHasActiveInsecureWindow(host));', $js);
        $this->assertStringContainsString('button[data-action="disable"]', $js);
        $this->assertStringContainsString('No active insecure host windows.', $js);
        $this->assertStringNotContainsString('insecureHostsExtendAllBtn', $js);
    }
}
