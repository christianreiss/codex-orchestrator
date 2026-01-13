<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminChatGptUsageLiveUpdateTest extends TestCase
{
    public function testDashboardListensForChatGptUsageEvents(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('admin-ws-event', $js);
        $this->assertStringContainsString('chatgpt.usage', $js);
        $this->assertStringContainsString('usage-reset', $js);
        $this->assertStringContainsString('startUsageResetTicker', $js);
    }
}
