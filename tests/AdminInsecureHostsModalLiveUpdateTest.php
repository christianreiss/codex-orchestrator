<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsModalLiveUpdateTest extends TestCase
{
    public function testInsecureHostsModalTracksCountdownsAndWsRefresh(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);
        $start = strpos($js, 'function openInsecureHostsModal(insecureHosts, insecureDomains)');
        $this->assertNotFalse($start);
        $end = strpos($js, 'async function loadAndOpenInsecureHostsModal()', $start);
        $this->assertNotFalse($end);
        $modalBlock = substr($js, $start, $end - $start);

        $this->assertStringContainsString('shouldRefreshInsecureModalForAction', $js);
        $this->assertStringContainsString('scheduleInsecureHostsModalRefresh', $js);
        $this->assertStringContainsString('data-countdown="host"', $modalBlock);
        $this->assertStringContainsString('data-countdown="domain"', $modalBlock);
        $this->assertStringContainsString('Active Windows (${activeCount})', $js);
        $this->assertStringContainsString('const activeHosts = items.filter((host) => hostHasActiveInsecureWindow(host));', $modalBlock);
        $this->assertStringContainsString('data-action="disable"', $modalBlock);
        $this->assertStringContainsString('No insecure hosts found.', $modalBlock);
        $this->assertStringContainsString('No active allowed domains.', $modalBlock);
        $this->assertStringNotContainsString('insecureHostsExtendAllBtn', $js);
        $this->assertStringNotContainsString('Window closed', $modalBlock);
        $this->assertStringNotContainsString('data-action="enable"', $modalBlock);
    }
}
