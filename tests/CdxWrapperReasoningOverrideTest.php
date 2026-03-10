<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperReasoningOverrideTest extends TestCase
{
    public function testWrapperUsesConfigOverrideForReasoningEffort(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'model_reasoning_effort=',
            $wrapperSource,
            'Wrapper should pass reasoning effort via config overrides.'
        );
        self::assertStringNotContainsString(
            '--reasoning-effort',
            $wrapperSource,
            'Wrapper should not pass the legacy --reasoning-effort flag.'
        );
    }

    public function testWrapperForcesReasoningSummaryNoneForSparkModel(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'codex_args_explicit_model',
            $wrapperSource,
            'Wrapper should parse explicit --model arguments.'
        );
        self::assertStringContainsString(
            'codex_args_explicit_profile',
            $wrapperSource,
            'Wrapper should parse explicit --profile arguments.'
        );
        self::assertStringContainsString(
            'config_profile_model',
            $wrapperSource,
            'Wrapper should resolve profile model values from config.toml.'
        );
        self::assertStringContainsString(
            'config_default_model',
            $wrapperSource,
            'Wrapper should resolve top-level default model values from config.toml.'
        );
        self::assertStringContainsString(
            'elif explicit_profile_name="$(codex_args_explicit_profile "$@")"; then',
            $wrapperSource,
            'Wrapper should derive effective model from explicit --profile when present.'
        );
        self::assertStringContainsString(
            'profile_model_name="$(config_profile_model "$explicit_profile_name")"',
            $wrapperSource,
            'Wrapper should map explicit profile names to their configured model.'
        );
        self::assertStringContainsString(
            'elif default_model_name="$(config_default_model)"; then',
            $wrapperSource,
            'Wrapper should fall back to top-level default model when explicit profile model is absent.'
        );
        self::assertStringContainsString(
            'profiles.${effective_profile_name}.model_reasoning_summary=none',
            $wrapperSource,
            'Wrapper should also disable profile-level reasoning summaries for spark profiles.'
        );
        self::assertStringContainsString(
            'effective_model_name',
            $wrapperSource,
            'Wrapper should derive an effective model before applying spark overrides.'
        );
        self::assertStringContainsString(
            'model_reasoning_summary=none',
            $wrapperSource,
            'Wrapper should disable reasoning summary whenever codex-spark is the effective model.'
        );
        self::assertStringContainsString(
            'effective_model_name="$default_model_name"',
            $wrapperSource,
            'Wrapper should treat top-level default model as the effective model when no explicit or injected model is set.'
        );
        self::assertStringContainsString(
            'set -- "$@" --sandbox read-only -a untrusted exec --skip-git-repo-check "$prompt"',
            $wrapperSource,
            'Wrapper execute mode should defer one-shot launch into the authenticated run path.'
        );
        self::assertStringContainsString(
            'Defer one-shot execution to the normal run path so auth/config sync still runs',
            $wrapperSource,
            'Wrapper execute mode should document why execute mode must run after sync.'
        );
        self::assertStringNotContainsString(
            'execute_selector_args=(--model gpt-5.3-codex)',
            $wrapperSource,
            'Wrapper execute mode should no longer bypass sync with its own early selector path.'
        );
        self::assertStringNotContainsString(
            '--output-last-message "$tmp_output"',
            $wrapperSource,
            'Wrapper execute mode should no longer short-circuit into a pre-sync direct codex invocation.'
        );
    }
}
