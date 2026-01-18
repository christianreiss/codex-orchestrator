<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminAuthResetUiTest extends TestCase
{
    public function testResetModalLivesInAuthOverlayStack(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        $this->assertIsString($html);

        $overlayPos = strpos($html, 'id="adminAuthOverlay"');
        $resetPos = strpos($html, 'id="adminResetModal"');
        $headerPos = strpos($html, '<header class="main-nav"');

        $this->assertNotFalse($overlayPos);
        $this->assertNotFalse($resetPos);
        $this->assertNotFalse($headerPos);
        $this->assertTrue($overlayPos < $resetPos, 'Reset modal should be rendered inside the auth overlay block.');
        $this->assertTrue($resetPos < $headerPos, 'Reset modal should render before the main admin shell.');
        $this->assertStringContainsString('class="modal auth-modal auth-reset"', $html);
    }
}
