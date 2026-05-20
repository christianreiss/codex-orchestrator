<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminLoginPageAssetsTest extends TestCase
{
    public function testLoginPageLoadsDedicatedAssets(): void
    {
        // The login UI is now a SvelteKit route. Verify key login-form
        // elements and auth integration are present in the Svelte source.
        $svelte = file_get_contents(__DIR__ . '/../frontend/src/routes/login/+page.svelte');
        $this->assertIsString($svelte);

        // Username and password fields exist.
        $this->assertStringContainsString('id="username"', $svelte);
        $this->assertStringContainsString('id="password"', $svelte);

        // The login page uses the auth store and navigates to the dashboard on success.
        $this->assertStringContainsString('authActions', $svelte);
        $this->assertStringContainsString('authStore', $svelte);
        $this->assertStringContainsString('/dashboard', $svelte);

        // No legacy asset references (old login.html era).
        $this->assertStringNotContainsString('login.js', $svelte);
        $this->assertStringNotContainsString('dashboard.js', $svelte);
        $this->assertStringNotContainsString('codex-logo.svg', $svelte);
    }

    public function testLoginScriptWarmsAdminShellInBackground(): void
    {
        // The SvelteKit shell preloads modules via rel="modulepreload" links
        // inserted by the build tooling. Verify the built shell uses this
        // mechanism rather than the legacy fetch-based warmAdminShell approach.
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('rel="modulepreload"', $html);
        $this->assertStringContainsString('_app/immutable/entry/', $html);

        // The SvelteKit app template uses data-sveltekit-preload-data instead
        // of manual fetch prefetching.
        $appHtml = file_get_contents(__DIR__ . '/../frontend/src/app.html');
        $this->assertIsString($appHtml);
        $this->assertStringContainsString('data-sveltekit-preload-data', $appHtml);
    }

    public function testDashboardLoadsSharedThemeAssetWithoutRemoteFonts(): void
    {
        // The SvelteKit shell must not pull in remote font providers.
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringNotContainsString('fonts.googleapis.com', $html);
        $this->assertStringNotContainsString('fonts.gstatic.com', $html);

        // The app.html template (source of truth for the shell) must not
        // reference remote fonts either.
        $appHtml = file_get_contents(__DIR__ . '/../frontend/src/app.html');
        $this->assertIsString($appHtml);
        $this->assertStringNotContainsString('fonts.googleapis.com', $appHtml);
        $this->assertStringNotContainsString('fonts.gstatic.com', $appHtml);

        // The SvelteKit CSS bundle is inlined via the build output.
        $this->assertStringContainsString('rel="stylesheet"', $html);
    }
}
