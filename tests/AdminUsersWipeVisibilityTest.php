<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminUsersWipeVisibilityTest extends TestCase
{
    public function testWipeButtonVisibilityTogglesWithUserCount(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/users.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('show(wipeBtn, false)', $js);
        $this->assertStringContainsString('show(wipeBtn, true)', $js);
    }
}
