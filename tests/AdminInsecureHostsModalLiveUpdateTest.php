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
    }
}
