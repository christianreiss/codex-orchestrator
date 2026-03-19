<?php

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsModalStateTest extends TestCase
{
    public function testModalKeepsClosedHostsVisibleWithEnableAction(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);

        self::assertStringContainsString("'<div class=\"quick-hosts-sub\">Window closed</div>'", $js);
        self::assertStringContainsString("const action = active ? 'disable' : 'enable';", $js);
        self::assertStringContainsString("const label = active ? 'Disable' : 'Enable';", $js);
        self::assertStringContainsString("const btn = e.target?.closest?.('button[data-action]');", $js);
    }
}
