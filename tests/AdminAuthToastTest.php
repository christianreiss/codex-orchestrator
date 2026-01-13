<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminAuthToastTest extends TestCase
{
    public function testAuthRetrieveToastsAreWired(): void
    {
        $source = file_get_contents(__DIR__ . '/../src/Repositories/LogRepository.php');
        $this->assertIsString($source);

        $this->assertStringContainsString("'auth.retrieve'", $source);
        $this->assertStringContainsString('CDX authorized', $source);
        $this->assertStringContainsString("'auth.denied'", $source);
        $this->assertStringContainsString("'auth.insecure.denied'", $source);
        $this->assertStringContainsString('CDX refused', $source);
    }
}
