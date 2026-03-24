<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminKeyboardShortcutsUiTest extends TestCase
{
    public function testAdminShellIncludesShortcutHelpTriggerAndModal(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);

        self::assertStringContainsString('id="navHelpTrigger"', $html);
        self::assertStringContainsString('id="helpModal"', $html);
        self::assertStringContainsString('Admin shortcuts', $html);
        self::assertStringContainsString('Go to Projects settings', $html);
        self::assertStringContainsString('Focus the host filter', $html);
    }

    public function testAdminDashboardWiresRealKeyboardShortcuts(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);

        self::assertStringContainsString("const navHelpTrigger = document.getElementById('navHelpTrigger');", $js);
        self::assertStringContainsString("const helpModal = document.getElementById('helpModal');", $js);
        self::assertStringContainsString('function handleGlobalShortcut(event)', $js);
        self::assertStringContainsString("if (key === '?') {", $js);
        self::assertStringContainsString("if (normalizedKey === 'n') {", $js);
        self::assertStringContainsString("if (key === '/') {", $js);
        self::assertStringContainsString("if (normalizedKey === 'r') {", $js);
        self::assertStringContainsString("p: '/admin/settings/projects'", $js);
        self::assertStringContainsString("document.addEventListener('keydown', handleGlobalShortcut);", $js);
    }

    public function testHostsTableIncludesAutoUpdatesColumnAndIndicators(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);
        self::assertStringContainsString('data-sort="auto_updates"', $html);
        self::assertStringContainsString('Auto-updates', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);
        self::assertStringContainsString('function hostAutoUpdateIndicator(host)', $js);
        self::assertStringContainsString("icon: '-'", $js);
        self::assertStringContainsString("icon: '✅'", $js);
        self::assertStringContainsString("icon: '⚠️'", $js);
        self::assertStringContainsString("case 'auto_updates':", $js);
        self::assertStringContainsString('host-auto-updates-indicator', $js);
    }
}
