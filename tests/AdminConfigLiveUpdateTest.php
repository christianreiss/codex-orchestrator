<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminConfigLiveUpdateTest extends TestCase
{
    public function testConfigBuilderListensForPushRefreshEvents(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/config.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('admin-data-dirty', $js);
        $this->assertStringContainsString("domains.includes('config')", $js);
        $this->assertStringContainsString('scheduleConfigReload', $js);
        $this->assertStringContainsString('Remote update available (unsaved edits)', $js);
    }
}
