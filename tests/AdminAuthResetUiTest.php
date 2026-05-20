<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAuthResetUiTest extends TestCase
{
    public function testDashboardNoLongerContainsAuthOverlayOrResetModal(): void
    {
        // The SvelteKit shell (public/admin/index.html) is a minimal HTML
        // wrapper — auth overlays and reset modals live in Svelte components,
        // not in the static shell, so none of the old IDs should appear there.
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringNotContainsString('id="adminAuthOverlay"', $html);
        $this->assertStringNotContainsString('id="adminResetModal"', $html);
        $this->assertStringNotContainsString('id="adminAuthForgot"', $html);
    }

    public function testDedicatedLoginPageContainsLoginForm(): void
    {
        // The login UI is now a SvelteKit route. Verify the Svelte source
        // contains a username input, a password input, and a submit form.
        $svelte = file_get_contents(__DIR__ . '/../frontend/src/routes/login/+page.svelte');
        $this->assertIsString($svelte);
        $this->assertStringContainsString('id="username"', $svelte);
        $this->assertStringContainsString('id="password"', $svelte);
        $this->assertStringContainsString('type="password"', $svelte);
        $this->assertStringContainsString('Enter your username.', $svelte);
    }
}
