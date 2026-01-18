<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminNavUserNameTest extends TestCase
{
    public function testNavUserElementAndHookExist(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);
        $this->assertStringContainsString('id="navUser"', $html);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/admin-auth.js');
        $this->assertIsString($js);
        $this->assertStringContainsString('navUser', $js);
    }
}
