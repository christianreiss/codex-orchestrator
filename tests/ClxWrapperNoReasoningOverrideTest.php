<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

/**
 * The Claude CLI does not support a reasoning_effort override — it is a
 * Codex/OpenAI concept. Regression: ensure the CLX wrapper does NOT reference
 * the Codex-side __CODEX_HOST_REASONING_EFFORT__ placeholder or set a
 * CLAUDE_REASONING_EFFORT env. This guards against copy-paste drift.
 */
final class ClxWrapperNoReasoningOverrideTest extends TestCase
{
    public function testWrapperHasNoReasoningEffortSymbol(): void
    {
        $wrapper = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapper);

        self::assertStringNotContainsString('__CODEX_HOST_REASONING_EFFORT__', $wrapper);
        self::assertStringNotContainsString('CLAUDE_REASONING_EFFORT', $wrapper);
        self::assertStringNotContainsString('reasoning_effort_override', $wrapper);
    }

    public function testConfigFragmentDoesNotApplyReasoningEffort(): void
    {
        $fragment = file_get_contents(__DIR__ . '/../bin/clx.d/03-sync-30-config.sh');
        self::assertIsString($fragment);

        self::assertStringNotContainsString('reasoning_effort', $fragment);
    }
}
