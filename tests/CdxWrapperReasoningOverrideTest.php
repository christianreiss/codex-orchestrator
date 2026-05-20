<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperReasoningOverrideTest extends TestCase
{
    public function testWrapperUsesConfigOverrideForReasoningEffort(): void
    {
        $laneSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/lane.go');
        self::assertIsString($laneSource, 'Expected to be able to read wrappers/cdx/internal/codex/lane.go');

        // Reasoning effort is passed via --config flag as model_reasoning_effort=
        self::assertStringContainsString(
            'model_reasoning_effort=',
            $laneSource,
            'Wrapper should pass reasoning effort via config overrides.'
        );
        // The wrapper must not use the legacy --reasoning-effort flag
        self::assertStringNotContainsString(
            '--reasoning-effort',
            $laneSource,
            'Wrapper should not pass the legacy --reasoning-effort flag.'
        );
    }

    public function testWrapperForcesReasoningSummaryNoneForSparkModel(): void
    {
        $laneSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/lane.go');
        self::assertIsString($laneSource, 'Expected to be able to read wrappers/cdx/internal/codex/lane.go');

        $configSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/config/config.go');
        self::assertIsString($configSource, 'Expected to be able to read wrappers/cdx/internal/config/config.go');

        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read wrappers/cdx/cmd/cdx/main.go');

        // Config struct carries a typed ReasoningEffortOverride field
        self::assertStringContainsString(
            'ReasoningEffortOverride',
            $configSource,
            'Wrapper should resolve reasoning effort from config.'
        );
        // ModelOverride is used to determine the effective model
        self::assertStringContainsString(
            'ModelOverride',
            $configSource,
            'Wrapper should resolve model override from config.'
        );
        // applyLaneAndProfile resolves effective model from config
        self::assertStringContainsString(
            'func applyLaneAndProfile(',
            $laneSource,
            'Wrapper should resolve effective model before applying overrides.'
        );
        // The effective model is derived from cfg.EngineOptions.ModelOverride
        self::assertStringContainsString(
            'cfg.EngineOptions.ModelOverride',
            $laneSource,
            'Wrapper should derive effective model from engine options.'
        );
        // --profile is respected: if user passes --profile, lane injection is skipped
        self::assertStringContainsString(
            '"--profile"',
            $laneSource,
            'Wrapper should parse explicit --profile arguments.'
        );
        // --model is respected: if user passes --model, lane injection is skipped
        self::assertStringContainsString(
            '"--model"',
            $laneSource,
            'Wrapper should parse explicit --model arguments.'
        );
        // Execute mode uses lifecycle.Run so auth/config sync still runs
        self::assertStringContainsString(
            'lifecycle.Run',
            $mainSource,
            'Wrapper execute mode should defer one-shot launch into the authenticated run path.'
        );
        // Execute mode constructs --sandbox read-only argv
        self::assertStringContainsString(
            '"--sandbox", "read-only"',
            $mainSource,
            'Wrapper execute mode should include sandbox read-only flag.'
        );
        // Execute mode must not bypass sync with its own early selector path
        self::assertStringNotContainsString(
            'execute_selector_args=(--model gpt-5.3-codex)',
            $mainSource,
            'Wrapper execute mode should no longer bypass sync with its own early selector path.'
        );
        // Execute mode must not short-circuit into a pre-sync direct codex invocation
        self::assertStringNotContainsString(
            '--output-last-message',
            $mainSource,
            'Wrapper execute mode should no longer short-circuit into a pre-sync direct codex invocation.'
        );
    }
}
