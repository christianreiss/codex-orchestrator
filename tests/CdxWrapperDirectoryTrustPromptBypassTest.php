<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperDirectoryTrustPromptBypassTest extends TestCase
{
    public function testWrapperForceTrustsCurrentWorkingDirectoryBeforeLaunch(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'ensure_project_path_trusted_in_config() {',
            $wrapperSource,
            'Wrapper should define helper for setting trust_level on project paths.'
        );
        self::assertStringContainsString(
            'CODEX_TRUST_PATH',
            $wrapperSource,
            'Wrapper should pass current project path into the trust updater.'
        );
        self::assertStringContainsString(
            'trust_level = "trusted"',
            $wrapperSource,
            'Wrapper should enforce trusted project entries to suppress interactive trust prompts.'
        );
        self::assertStringContainsString(
            'ensure_current_project_trusted_in_config',
            $wrapperSource,
            'Wrapper should include a pre-launch hook for trusting current project paths.'
        );

        $trustCallPos = strpos($wrapperSource, "\nensure_current_project_trusted_in_config\n\ncdx_debug_phase");
        $launchPos = strpos($wrapperSource, 'if run_codex_command "$@"; then');
        self::assertNotFalse($trustCallPos, 'Expected pre-launch trust call in wrapper source.');
        self::assertNotFalse($launchPos, 'Expected Codex launch call in wrapper source.');
        self::assertLessThan($launchPos, $trustCallPos, 'Expected trust call to run before launching Codex.');
    }
}
