<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthRunnerProbeSandboxTest extends TestCase
{
    public function testRunnerProbeDoesNotUseDangerousSandboxBypass(): void
    {
        $py = file_get_contents(__DIR__ . '/../runner/app.py');
        $this->assertIsString($py);

        $this->assertStringNotContainsString('--dangerously-bypass-approvals-and-sandbox', $py);
        $this->assertStringNotContainsString('danger-full-access', $py);
        $this->assertStringContainsString('"read-only"', $py);
    }
}

