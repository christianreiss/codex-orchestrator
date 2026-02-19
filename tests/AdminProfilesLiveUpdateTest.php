<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminProfilesLiveUpdateTest extends TestCase
{
    public function testProfilesPanelListensForPushRefreshEvents(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/profiles.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('admin-data-dirty', $js);
        $this->assertStringContainsString("domains.includes('profiles')", $js);
        $this->assertStringContainsString('scheduleProfilesReload', $js);
        $this->assertStringContainsString('Remote update available (unsaved edits)', $js);
    }
}
