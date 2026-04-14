<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class RunnerValidationServiceClaudeStateTest extends TestCase
{
    public function testRecordRunnerOutcomeUsesEngineScopedKeys(): void
    {
        $service = file_get_contents(__DIR__ . '/../src/Services/RunnerValidationService.php');
        self::assertIsString($service);

        self::assertStringContainsString("'runner_state_claude'", $service);
        self::assertStringContainsString("'runner_last_check_claude'", $service);
        self::assertStringContainsString("'runner_last_ok_claude'", $service);
        self::assertStringContainsString("'runner_last_fail_claude'", $service);

        // And the Codex keys stay unchanged for back-compat.
        self::assertStringContainsString("'runner_state'", $service);
        self::assertStringContainsString("'runner_last_check'", $service);
    }

    public function testTriggerRunnerRefreshClaudeBypassesCodexCanonicalLadder(): void
    {
        $service = file_get_contents(__DIR__ . '/../src/Services/RunnerValidationService.php');
        self::assertIsString($service);

        // Must resolve the Claude canonical payload (engine-scoped) and call verifyClaude directly.
        self::assertStringContainsString('resolveCanonicalPayload($engine)', $service);
        self::assertStringContainsString('$this->runnerVerifier->verifyClaude($authArray)', $service);
    }

    public function testRecordRunnerOutcomeAcceptsEngineArgAndDefaultsToCodex(): void
    {
        $service = file_get_contents(__DIR__ . '/../src/Services/RunnerValidationService.php');
        self::assertIsString($service);

        self::assertStringContainsString('public function recordRunnerOutcome(array $validation, bool $reachable, string $trigger, string $engine = Engine::DEFAULT)', $service);
    }
}
