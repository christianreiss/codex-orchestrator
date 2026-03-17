<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AdminPasskeyRecoveryScriptTest extends TestCase
{
    public function testRecoveryScriptSupportsDockerOperatorFlow(): void
    {
        $script = file_get_contents(__DIR__ . '/../scripts/admin-passkeys.php');
        $this->assertIsString($script);

        $this->assertStringContainsString("delete-user --username <admin> [--force]", $script);
        $this->assertStringContainsString("admin.passkey.recovery.delete", $script);
        $this->assertStringContainsString("no passkeys found for", $script);
    }
}
