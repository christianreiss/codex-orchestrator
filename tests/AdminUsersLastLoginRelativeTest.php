<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersLastLoginRelativeTest extends TestCase
{
    public function testLastLoginRelativeMarkupPresent(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/users.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('table-subtext', $js);
        $this->assertStringContainsString('formatRelative', $js);
    }
}
