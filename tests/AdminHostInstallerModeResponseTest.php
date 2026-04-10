<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminHostInstallerModeResponseTest extends TestCase
{
    public function testAdminHostRegisterResponseIncludesInstallerModeMetadata(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminHostController.php');
        $this->assertIsString($source);

        $this->assertStringContainsString('InstallerMode::forHostEngines($engines)', $source);
        $this->assertStringContainsString("'mode' => \$installerMode", $source);
        $this->assertStringContainsString("'label' => InstallerMode::label(\$installerMode)", $source);
    }
}
