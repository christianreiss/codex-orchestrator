<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminToastUiTest extends TestCase
{
    public function testToastDeckExistsInAdminShell(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $this->assertStringContainsString('id="toastDeck"', $html);
        $this->assertStringContainsString('class="toast-deck"', $html);
    }

    public function testToastStylesAndHandlersExist(): void
    {
        $css = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.css');
        $this->assertIsString($css);

        $this->assertStringContainsString('.toast-deck', $css);
        $this->assertStringContainsString('.toast.level-success', $css);

        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        $this->assertIsString($js);

        $this->assertStringContainsString('toastFromEvent', $js);
        $this->assertStringContainsString("detail.type === 'toast'", $js);
    }
}
