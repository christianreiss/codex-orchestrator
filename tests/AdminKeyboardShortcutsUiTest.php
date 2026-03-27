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
        self::assertStringContainsString('Keyboard shortcuts', $html);
        self::assertStringContainsString('Settings: projects', $html);
        self::assertStringContainsString('Focus the active search / filter', $html);
        self::assertStringContainsString('Toggle the visible drawer/panel', $html);
        self::assertStringNotContainsString('id="kbdShortcutsModal"', $html);
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
        self::assertStringContainsString('function triggerNewShortcut()', $js);
        self::assertStringContainsString("if (pendingShortcutPrefix === normalizedKey) {", $js);
        self::assertStringContainsString("window.__railNav?.toggleGroup?.(prefix === 'h' ? 'hosts' : prefix === 'l' ? 'logs' : prefix === 's' ? 'settings' : '');", $js);
        self::assertStringContainsString("window.__railNav?.toggleGroup?.(normalizedKey === 'h' ? 'hosts' : normalizedKey === 'l' ? 'logs' : 'settings');", $js);
        self::assertStringContainsString("document.addEventListener('keydown', handleGlobalShortcut);", $js);
        self::assertStringNotContainsString("const kbdModal = document.getElementById('kbdShortcutsModal');", $js);
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
        self::assertStringContainsString('host?.auto_update_label', $js);
        self::assertStringContainsString('host?.auto_update_emoji', $js);
        self::assertStringContainsString('host?.auto_update_rank', $js);
        self::assertStringContainsString('host?.auto_update_state', $js);
        self::assertStringContainsString('host?.auto_update_last_event_at', $js);
        self::assertStringContainsString("case 'auto_updates':", $js);
        self::assertStringContainsString('host-auto-updates-indicator', $js);
        self::assertStringContainsString("label: 'Auto-updates'", $js);
    }
}
