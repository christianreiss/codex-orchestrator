<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminKeyboardShortcutsUiTest extends TestCase
{
    public function testAdminShellIncludesShortcutHelpTriggerAndModal(): void
    {
        $shortcutsModal = file_get_contents(__DIR__ . '/../frontend/src/lib/components/shortcuts/ShortcutsModal.svelte');
        self::assertIsString($shortcutsModal);

        // Shortcuts modal dialog contains the help title
        self::assertStringContainsString('Keyboard shortcuts', $shortcutsModal);
        // Modal opens via window event
        self::assertStringContainsString('codex:open-shortcuts', $shortcutsModal);
        // Modal renders the shortcut entries
        self::assertStringContainsString('{#each ENTRIES as entry', $shortcutsModal);
        // Escape shortcut to close overlays is documented
        self::assertStringContainsString('Esc', $shortcutsModal);

        $commands = file_get_contents(__DIR__ . '/../frontend/src/lib/components/command-palette/commands.ts');
        self::assertIsString($commands);
        // Command palette has a command to open shortcuts
        self::assertStringContainsString('action:open-shortcuts', $commands);
        self::assertStringContainsString('codex:open-shortcuts', $commands);

        $commandPalette = file_get_contents(__DIR__ . '/../frontend/src/lib/components/command-palette/CommandPalette.svelte');
        self::assertIsString($commandPalette);
        // ShortcutsModal is globally mounted inside CommandPalette
        self::assertStringContainsString('ShortcutsModal', $commandPalette);
    }

    public function testAdminDashboardWiresRealKeyboardShortcuts(): void
    {
        $shortcuts = file_get_contents(__DIR__ . '/../frontend/src/lib/utils/shortcuts.ts');
        self::assertIsString($shortcuts);

        // '?' triggers the shortcuts modal
        self::assertStringContainsString('event.key === "?"', $shortcuts);
        // '/' opens the command palette
        self::assertStringContainsString('event.key === "/"', $shortcuts);
        // Escape closes overlays
        self::assertStringContainsString('event.key === "Escape"', $shortcuts);
        // Modifier keys suppress shortcuts (e.g. Cmd-K not captured here)
        self::assertStringContainsString('event.metaKey || event.ctrlKey', $shortcuts);
        // Global shortcut binding exported
        self::assertStringContainsString('export function bindGlobalShortcuts', $shortcuts);
        // Typing in form fields is ignored
        self::assertStringContainsString('isTypingInField', $shortcuts);
        // Handler is registered on window
        self::assertStringContainsString('window.addEventListener("keydown", handler)', $shortcuts);

        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        self::assertIsString($layout);
        // Layout wires up shortcuts on mount
        self::assertStringContainsString('bindGlobalShortcuts', $layout);
        // '/' opens command palette
        self::assertStringContainsString('"/": () => commandPalette.open()', $layout);
        // '?' dispatches the shortcuts event
        self::assertStringContainsString("codex:open-shortcuts", $layout);
        // Cmd-K / Ctrl-K handled in layout
        self::assertStringContainsString('metaKey || event.ctrlKey', $layout);
        // Command palette toggle wired to Cmd-K
        self::assertStringContainsString('commandPalette.toggle()', $layout);

        $commands = file_get_contents(__DIR__ . '/../frontend/src/lib/components/command-palette/commands.ts');
        self::assertIsString($commands);
        // New-host action navigates to /hosts/new
        self::assertStringContainsString('/hosts/new', $commands);
        // Quick-VM action fires a window event
        self::assertStringContainsString('codex:open-quick-vm', $commands);
        // Settings deep-link is registered
        self::assertStringContainsString('/settings', $commands);
        // Sign-out action calls authActions.logout
        self::assertStringContainsString('authActions.logout', $commands);
    }

    public function testHostsTableIncludesAutoUpdatesColumnAndIndicators(): void
    {
        $hostsTable = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/HostsTable.svelte');
        self::assertIsString($hostsTable);

        // Auto-update column header is present
        self::assertStringContainsString('Auto-upd.', $hostsTable);
        // Auto-update sort field is wired
        self::assertStringContainsString('effective_auto_update_enabled', $hostsTable);
        // Toggle switch rendered for auto-update
        self::assertStringContainsString('onToggleAutoUpdate', $hostsTable);
        // Toggle auto-update aria-label references fqdn
        self::assertStringContainsString('Toggle auto-update for', $hostsTable);

        $hostsApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/hosts.ts');
        self::assertIsString($hostsApi);
        // Auto-update mutation factory exported
        self::assertStringContainsString('createAutoUpdateToggleMutation', $hostsApi);
        // Auto-update endpoint path
        self::assertStringContainsString('/auto-update', $hostsApi);
        // effective_auto_update_enabled applied in optimistic update
        self::assertStringContainsString('effective_auto_update_enabled', $hostsApi);
    }

    public function testSecureHostsTabHidesInsecureWindowColumn(): void
    {
        $hostsPage = file_get_contents(__DIR__ . '/../frontend/src/routes/hosts/+page.svelte');
        self::assertIsString($hostsPage);

        // Secure filter chip exists
        self::assertStringContainsString('"secure"', $hostsPage);
        // Insecure filter chip exists
        self::assertStringContainsString('"insecure"', $hostsPage);
        // Filter is URL-synced
        self::assertStringContainsString('searchParams.get', $hostsPage);

        $hostsApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/hosts.ts');
        self::assertIsString($hostsApi);
        // hostMatchesFilter classifies secure hosts
        self::assertStringContainsString('case "secure":', $hostsApi);
        // isInsecureWindowActive helper drives insecure column visibility
        self::assertStringContainsString('export function isInsecureWindowActive', $hostsApi);

        $hostsTable = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/HostsTable.svelte');
        self::assertIsString($hostsTable);
        // Insecure countdown cell is rendered per row
        self::assertStringContainsString('InsecureCountdown', $hostsTable);
        // isInsecureWindowActive is imported and used to set row state
        self::assertStringContainsString('isInsecureWindowActive', $hostsTable);
    }
}
