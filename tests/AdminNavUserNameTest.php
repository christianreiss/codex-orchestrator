<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminNavUserNameTest extends TestCase
{
    public function testUpperRightAccountMenuHooksExist(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="navAccountGroup"', $html);
        $this->assertStringContainsString('id="navAccountTrigger"', $html);
        $this->assertStringContainsString('id="navAccountTriggerLabel"', $html);
        $this->assertStringContainsString('id="navAccountSummary"', $html);
        $this->assertStringContainsString('id="navAccountName"', $html);
        $this->assertStringContainsString('id="navAccountPasswordLink"', $html);
        $this->assertStringContainsString('id="navAccountPasskeysLink"', $html);
        $this->assertStringContainsString('id="navLogout"', $html);
        $this->assertStringContainsString('aria-label="Codex Orchestrator dashboard"', $html);
        $this->assertStringContainsString('rail-brand-tagline', $html);
        $this->assertStringContainsString('Codex to Brrr!', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/admin-auth.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('navAccountGroup', $js);
        $this->assertStringContainsString('navAccountTriggerLabel', $js);
        $this->assertStringContainsString('navAccountName', $js);
        $this->assertStringContainsString('navAccountPasswordLink', $js);
        $this->assertStringContainsString('logoutModal', $js);
        $this->assertStringContainsString('window.__adminBootstrap', $js);
        $this->assertStringContainsString("credentials: 'same-origin'", $js);
    }
}
