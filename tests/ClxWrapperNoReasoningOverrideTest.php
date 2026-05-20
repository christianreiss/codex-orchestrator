<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * The Claude CLI does not support a reasoning_effort override — it is a
 * Codex/OpenAI concept. Regression: ensure the CLX wrapper does NOT inject
 * a CLAUDE_REASONING_EFFORT env var or reference the Codex-side
 * __CODEX_HOST_REASONING_EFFORT__ placeholder. This guards against
 * copy-paste drift from the cdx wrapper.
 */
final class ClxWrapperNoReasoningOverrideTest extends TestCase
{
    public function testWrapperHasNoReasoningEffortSymbol(): void
    {
        // BuildEnv constructs the environment seen by the upstream claude CLI.
        // It must not set CLAUDE_REASONING_EFFORT.
        $envSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/env.go');
        self::assertIsString($envSource);

        self::assertStringNotContainsString('CLAUDE_REASONING_EFFORT', $envSource);
        self::assertStringNotContainsString('__CODEX_HOST_REASONING_EFFORT__', $envSource);
        self::assertStringNotContainsString('reasoning_effort_override', $envSource);

        // PreExec must not inject a reasoning-effort env var either.
        $preexecSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/preexec.go');
        self::assertIsString($preexecSource);

        self::assertStringNotContainsString('CLAUDE_REASONING_EFFORT', $preexecSource);
        self::assertStringNotContainsString('reasoning_effort_override', $preexecSource);

        // The main entrypoint must not reference the Codex placeholder.
        $mainSource = file_get_contents(__DIR__ . '/../wrappers/clx/cmd/clx/main.go');
        self::assertIsString($mainSource);

        self::assertStringNotContainsString('__CODEX_HOST_REASONING_EFFORT__', $mainSource);
        self::assertStringNotContainsString('reasoning_effort_override', $mainSource);
    }

    public function testConfigFragmentDoesNotApplyReasoningEffort(): void
    {
        // The HostInfo struct may carry a claude_reasoning_effort_override field
        // to receive server data, but it must never be forwarded to the claude
        // binary as a CLAUDE_REASONING_EFFORT environment variable.
        $authSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/auth.go');
        self::assertIsString($authSource);

        // The field may exist in the data struct (server-driven) …
        // but the env builder must not consume it.
        $envSource = file_get_contents(__DIR__ . '/../wrappers/clx/internal/claude/env.go');
        self::assertIsString($envSource);

        self::assertStringNotContainsString('ReasoningEffort', $envSource);
        self::assertStringNotContainsString('CLAUDE_REASONING_EFFORT', $envSource);
        self::assertStringNotContainsString('reasoning_effort', $envSource);
    }
}
