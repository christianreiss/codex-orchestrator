<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminThemePresetsTest extends TestCase
{
    public function testAdminThemeMenuIncludesPinkPresets(): void
    {
        $svelte = file_get_contents(__DIR__ . '/../frontend/src/routes/account/theme/+page.svelte');
        $this->assertIsString($svelte);

        $this->assertStringContainsString('data-theme-option="auto-pink"', $svelte);
        $this->assertStringContainsString('data-theme-option="bright-pink"', $svelte);
        $this->assertStringContainsString('data-theme-option="dark-pink"', $svelte);
        $this->assertStringContainsString('>Auto Pink</button>', $svelte);
        $this->assertStringContainsString('>Bright Pink</button>', $svelte);
        $this->assertStringContainsString('>Dark Pink</button>', $svelte);
    }

    public function testDashboardAndAuthScriptsAcceptPinkThemePreferences(): void
    {
        $themePage = file_get_contents(__DIR__ . '/../frontend/src/routes/account/theme/+page.svelte');
        $accountApi = file_get_contents(__DIR__ . '/../frontend/src/lib/api/account.ts');
        $appCss = file_get_contents(__DIR__ . '/../frontend/src/app.css');

        $this->assertIsString($themePage);
        $this->assertIsString($accountApi);
        $this->assertIsString($appCss);

        $this->assertStringContainsString('data-theme-option="auto-pink"', $themePage);
        $this->assertStringContainsString('data-theme-option="bright-pink"', $themePage);
        $this->assertStringContainsString('data-theme-option="dark-pink"', $themePage);
        $this->assertStringContainsString('auto-pink', $appCss);
        $this->assertStringContainsString('bright-pink', $appCss);
        $this->assertStringContainsString('dark-pink', $appCss);
        $this->assertStringContainsString('/admin/theme', $accountApi);
    }

    public function testSharedAndDashboardStylesDefinePinkThemeTokens(): void
    {
        $appCss = file_get_contents(__DIR__ . '/../frontend/src/app.css');

        $this->assertIsString($appCss);

        $this->assertStringContainsString('body[data-theme="auto-pink"]', $appCss);
        $this->assertStringContainsString('body[data-theme="bright-pink"]', $appCss);
        $this->assertStringContainsString('body[data-theme="dark-pink"]', $appCss);
        $this->assertStringContainsString('--accent: #ec4899;', $appCss);
        $this->assertStringContainsString('--accent: #f472b6;', $appCss);
    }
}
