<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminNavDrawerUiTest extends TestCase
{
    public function testAdminMarkupIncludesDrawerNavigationShell(): void
    {
        $sidebar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/Sidebar.svelte');
        $this->assertIsString($sidebar);

        // Sidebar renders a nav with a list of nav items from NAV config
        $this->assertStringContainsString('aria-label="Primary"', $sidebar);
        $this->assertStringContainsString('{#each NAV as item', $sidebar);
        // Account links are present in the user dropdown
        $this->assertStringContainsString('/account/password', $sidebar);
        $this->assertStringContainsString('/account/passkeys', $sidebar);
        // Sign-out is wired
        $this->assertStringContainsString('signOut', $sidebar);
        // User display name shown
        $this->assertStringContainsString('auth.user.name', $sidebar);

        $topBar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/TopBar.svelte');
        $this->assertIsString($topBar);
        // Theme picker exists in TopBar
        $this->assertStringContainsString('setTheme', $topBar);
        // Insecure-windows indicator is rendered when activeWindows > 0
        $this->assertStringContainsString('{#if activeWindows > 0}', $topBar);

        $themeStore = file_get_contents(__DIR__ . '/../frontend/src/lib/stores/theme.ts');
        $this->assertIsString($themeStore);
        // Three theme modes are supported
        $this->assertStringContainsString('"light"', $themeStore);
        $this->assertStringContainsString('"dark"', $themeStore);
        $this->assertStringContainsString('"system"', $themeStore);
    }

    public function testNavControllerWiresDrawerAndActiveSyncBehavior(): void
    {
        $nav = file_get_contents(__DIR__ . '/../frontend/src/lib/nav.ts');
        $this->assertIsString($nav);

        // NAV array is exported and used as single source of truth
        $this->assertStringContainsString('export const NAV', $nav);
        // Dashboard and key sections are registered
        $this->assertStringContainsString('href: "/dashboard"', $nav);
        $this->assertStringContainsString('href: "/hosts"', $nav);
        $this->assertStringContainsString('href: "/settings"', $nav);
        // isActive helper exported for active link sync
        $this->assertStringContainsString('export function isActive', $nav);

        $sidebar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/Sidebar.svelte');
        $this->assertIsString($sidebar);
        // Sidebar uses isActive to sync active links
        $this->assertStringContainsString('isActive', $sidebar);
        $this->assertStringContainsString("aria-current={active ? \"page\" : undefined}", $sidebar);

        $themeStore = file_get_contents(__DIR__ . '/../frontend/src/lib/stores/theme.ts');
        $this->assertIsString($themeStore);
        // Theme stored and applied on init
        $this->assertStringContainsString('localStorage', $themeStore);
        $this->assertStringContainsString('export function setTheme', $themeStore);

        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);
        // Layout binds global keyboard shortcuts
        $this->assertStringContainsString('bindGlobalShortcuts', $layout);
        // WebSocket client is wired up in layout
        $this->assertStringContainsString('createWsClient', $layout);
        // Auth store drives redirect logic
        $this->assertStringContainsString('authStore', $layout);
    }

    public function test2026NavStylesAreScopedAndResponsive(): void
    {
        $css = file_get_contents(__DIR__ . '/../frontend/src/app.css');
        $this->assertIsString($css);

        // CSS custom properties for sidebar theming
        $this->assertStringContainsString('--sidebar-bg', $css);
        $this->assertStringContainsString('--sidebar-fg', $css);
        $this->assertStringContainsString('--sidebar-active', $css);
        // Dark-mode overrides
        $this->assertStringContainsString('.dark {', $css);
        $this->assertStringContainsString('--background', $css);
        $this->assertStringContainsString('--foreground', $css);

        $mobileNav = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/MobileNav.svelte');
        $this->assertIsString($mobileNav);
        // Mobile nav is hidden on larger screens (responsive)
        $this->assertStringContainsString('md:hidden', $mobileNav);
        // Fixed bottom bar for mobile
        $this->assertStringContainsString('fixed bottom-0', $mobileNav);

        $sidebar = file_get_contents(__DIR__ . '/../frontend/src/lib/components/layout/Sidebar.svelte');
        $this->assertIsString($sidebar);
        // Sidebar is hidden on mobile, shown on md+
        $this->assertStringContainsString('md:flex', $sidebar);
    }
}
