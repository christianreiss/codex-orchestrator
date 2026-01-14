<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class InsecureApprovalAuthServiceTest extends TestCase
{
    public function testAuthServiceIncludesInsecureApprovalFlow(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Services/AuthService.php');
        $this->assertIsString($source);

        $this->assertStringContainsString('insecure_approval_enabled', $source);
        $this->assertStringContainsString('auth.insecure.pending', $source);
        $this->assertStringContainsString('Insecure host approval pending', $source);
        $this->assertStringContainsString('auth.insecure.domain_auto_allow', $source);
    }
}
