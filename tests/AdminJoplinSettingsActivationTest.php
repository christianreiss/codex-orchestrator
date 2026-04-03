<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminJoplinSettingsActivationTest extends TestCase
{
    public function testAdminRouterServesJoplinSettingsPageAndEndpoints(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString('/admin/settings/(general|users|agents|memories|projects|profiles|skills|config|apikeys|joplin)', $source);
        $this->assertStringContainsString("#^/admin/joplin/config$#", $source);
        $this->assertStringContainsString("#^/admin/joplin/test$#", $source);
        $this->assertStringContainsString("#^/admin/joplin/sync$#", $source);
    }

    public function testBackendRequiresSavedVerifiedConfigBeforeActivation(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminJoplinController.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("joplin_verified_config_hash", $source);
        $this->assertStringContainsString("joplin_verified_at", $source);
        $this->assertStringContainsString('Save the Joplin configuration before enabling the module', $source);
        $this->assertStringContainsString('Save the Joplin configuration before testing the connection', $source);
        $this->assertStringContainsString('Run a successful connection test on the saved Joplin configuration before enabling the module', $source);
        $this->assertStringContainsString("'auto_disabled' => \$autoDisabled", $source);
        $this->assertStringContainsString("'verified_connection' => \$verifiedConnection", $source);
        $this->assertStringContainsString("'can_activate' => \$activationReason === 'ready'", $source);
    }

    public function testDashboardWiresJoplinSetupAsSaveThenTestThenEnable(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $script = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($html);
        $this->assertIsString($script);

        $this->assertStringContainsString('Save the connection details, run a successful connection test, then enable Joplin note sync.', $html);
        $this->assertStringContainsString('id="joplinEnabledToggle" disabled', $html);
        $this->assertStringContainsString('id="joplinTestBtn" type="button" disabled', $html);
        $this->assertStringContainsString("await api('/admin/joplin/config');", $script);
        $this->assertStringContainsString("await api('/admin/joplin/config', { method: 'POST', json: body });", $script);
        $this->assertStringContainsString("await api('/admin/joplin/test', { method: 'POST', json: {} });", $script);
        $this->assertStringContainsString('Unsaved changes. Save before testing the connection or enabling the module.', $script);
        $this->assertStringContainsString('Saved configuration needs a successful connection test before activation.', $script);
        $this->assertStringContainsString('Connection settings changed. Joplin was disabled until the saved config is tested again.', $script);
    }
}
