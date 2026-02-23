<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class AuthRunnerSharedSecretTest extends TestCase
{
    public function testRunnerVerifierSendsSharedSecretHeaderWhenConfigured(): void
    {
        $php = file_get_contents(__DIR__ . '/../src/Services/RunnerVerifier.php');
        $this->assertIsString($php);
        $this->assertStringContainsString('X-Runner-Auth', $php);
        $this->assertStringContainsString('sharedSecret', $php);
    }

    public function testRunnerEndpointValidatesSharedSecret(): void
    {
        $py = file_get_contents(__DIR__ . '/../runner/app.py');
        $this->assertIsString($py);
        $this->assertStringContainsString('RUNNER_SHARED_SECRET', $py);
        $this->assertStringContainsString('secrets.compare_digest', $py);
        $this->assertStringContainsString('status_code=401', $py);
    }
}

