<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminNavUserNameTest extends TestCase
{
    public function testBrandAccountMenuHooksExist(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="navAccountSummary"', $html);
        $this->assertStringContainsString('id="navAccountName"', $html);
        $this->assertStringContainsString('id="navLogout"', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/admin-auth.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('navAccountName', $js);
        $this->assertStringContainsString('navAccountPasswordLink', $js);
        $this->assertStringContainsString('logoutModal', $js);
    }
}
