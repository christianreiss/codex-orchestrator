<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class MtlsDebugGateTest extends TestCase
{
    public function testMtlsDebugIsGuardedByCodexDebugEnv(): void
    {
        $php = file_get_contents(__DIR__ . '/../public/mtls-debug.php');
        $this->assertIsString($php);

        $this->assertStringContainsString("Config::get('CODEX_DEBUG'", $php);
        $this->assertStringContainsString('http_response_code(404)', $php);
    }
}

