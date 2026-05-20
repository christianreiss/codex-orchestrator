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

    public function testWrapperSupportsDangerousBypassFlagFromConfig(): void
    {
        // The bash wrapper was replaced by a Go binary; verify the equivalent
        // behaviour lives in the Go sources instead.
        $execGo = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        $this->assertIsString($execGo);

        $laneGo = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/lane.go');
        $this->assertIsString($laneGo);

        $configGo = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/config/config.go');
        $this->assertIsString($configGo);

        // The CLI flag must appear in the Go source that builds the argument list.
        $this->assertStringContainsString('--dangerously-bypass-approvals-and-sandbox', $laneGo);

        // The config key must be present in the config struct (JSON tag).
        $this->assertStringContainsString('dangerously_bypass_approvals_and_sandbox', $configGo);

        // exec.go must call the bypass helper so the flag is actually applied.
        $this->assertStringContainsString('applyDangerousBypass', $execGo);
    }
}
