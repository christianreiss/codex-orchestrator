<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class RunnerExecModelRoutingTest extends TestCase
{
    public function testRunnerExecRequestAcceptsOptionalModelField(): void
    {
        $source = file_get_contents(__DIR__ . '/../runner/app.py');

        $this->assertIsString($source);
        $this->assertStringContainsString('model: Optional[str] = Field(None, description="Codex model to execute")', $source);
    }

    public function testRunnerBuildsCodexExecCommandWithModelSelectorBeforeExec(): void
    {
        $source = file_get_contents(__DIR__ . '/../runner/app.py');

        $this->assertIsString($source);
        $this->assertStringContainsString('cmd.extend(["--model", model.strip()])', $source);
        $this->assertStringContainsString('"exec",', $source);
    }
}
