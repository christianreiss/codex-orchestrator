<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class InsecureApprovalRoutesTest extends TestCase
{
    public function testAdminInsecureApprovalRoutesExist(): void
    {
        $source = file_get_contents(__DIR__ . '/../public/index.php');
        $this->assertIsString($source);

        $this->assertStringContainsString('/admin/insecure-approval', $source);
        $this->assertStringContainsString('/admin/insecure-approvals', $source);
    }
}
