<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminAuthBootstrapTest extends TestCase
{
    public function testAdminShellBootstrapsAuthStateFromServerSession(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/admin/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("window.__adminBootstrap =", $source);
        $this->assertStringContainsString("'id=\"navAccountGroup\" data-nav=\"account\" style=\"display:none;\"'", $source);
        $this->assertStringContainsString("'id=\"navAccountTriggerLabel\">Authenticated user</span>'", $source);
        $this->assertStringContainsString("'id=\"navAccountSummary\" style=\"display:none;\"'", $source);
        $this->assertStringContainsString("'id=\"navLogout\" type=\"button\" role=\"menuitem\" style=\"display:none;\"'", $source);
        $this->assertStringContainsString("json_encode(\$bootstrap", $source);
    }
}
