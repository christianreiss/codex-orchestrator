<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminThemePresetsTest extends TestCase
{
    public function testAdminThemeMenuIncludesPinkPresets(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('data-theme-option="auto-pink"', $html);
        $this->assertStringContainsString('data-theme-option="bright-pink"', $html);
        $this->assertStringContainsString('data-theme-option="dark-pink"', $html);
        $this->assertStringContainsString('>Auto Pink</button>', $html);
        $this->assertStringContainsString('>Bright Pink</button>', $html);
        $this->assertStringContainsString('>Dark Pink</button>', $html);
    }

    public function testDashboardAndAuthScriptsAcceptPinkThemePreferences(): void
    {
        $dashboardJs = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $loginJs = file_get_contents(__DIR__ . '/../public/admin/assets/login.js');
        $verifyJs = file_get_contents(__DIR__ . '/../public/admin/assets/cli-auth-verify.js');

        $this->assertIsString($dashboardJs);
        $this->assertIsString($loginJs);
        $this->assertIsString($verifyJs);

        $this->assertStringContainsString("'auto-pink'", $dashboardJs);
        $this->assertStringContainsString("'bright-pink'", $dashboardJs);
        $this->assertStringContainsString("'dark-pink'", $dashboardJs);
        $this->assertStringContainsString("'Auto Pink'", $dashboardJs);
        $this->assertStringContainsString("'Bright Pink'", $dashboardJs);
        $this->assertStringContainsString("'Dark Pink'", $dashboardJs);
        $this->assertStringContainsString("if (normalized !== 'auto-pink') {", $dashboardJs);
        $this->assertStringContainsString("document.body.dataset.themePreference = normalized;", $dashboardJs);
        $this->assertStringContainsString("if (stored === 'auto-pink') {", $dashboardJs);
        $this->assertStringContainsString("'auto-pink'", $loginJs);
        $this->assertStringContainsString("'bright-pink'", $loginJs);
        $this->assertStringContainsString("'dark-pink'", $loginJs);
        $this->assertStringContainsString("if (theme !== 'auto-pink') {", $loginJs);
        $this->assertStringContainsString("'auto-pink'", $verifyJs);
        $this->assertStringContainsString("'bright-pink'", $verifyJs);
        $this->assertStringContainsString("'dark-pink'", $verifyJs);
        $this->assertStringContainsString("if (theme !== 'auto-pink') {", $verifyJs);
        $this->assertStringContainsString("api('/admin/theme'", $dashboardJs);
        $this->assertStringContainsString("const THEME_SYNC_STORAGE_KEY = 'adminThemeSynced';", $dashboardJs);
        $this->assertStringContainsString('void persistThemePreference(initial, { silent: true });', $dashboardJs);
        $this->assertStringContainsString('void persistThemePreference(nextTheme, { silent: true });', $dashboardJs);
    }

    public function testSharedAndDashboardStylesDefinePinkThemeTokens(): void
    {
        $themeCss = file_get_contents(__DIR__ . '/../public/admin/assets/theme.css');
        $dashboardCss = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');

        $this->assertIsString($themeCss);
        $this->assertIsString($dashboardCss);

        $this->assertStringContainsString('body[data-theme="auto-pink"]', $themeCss);
        $this->assertStringContainsString('body[data-theme="bright-pink"]', $themeCss);
        $this->assertStringContainsString('body[data-theme="dark-pink"]', $themeCss);
        $this->assertStringContainsString('--accent: #ec4899;', $themeCss);
        $this->assertStringContainsString('--accent: #ff5cab;', $themeCss);
        $this->assertStringContainsString('body[data-theme="auto-pink"]', $dashboardCss);
        $this->assertStringContainsString('body[data-theme="bright-pink"]', $dashboardCss);
        $this->assertStringContainsString('body[data-theme="dark-pink"]', $dashboardCss);
    }
}
