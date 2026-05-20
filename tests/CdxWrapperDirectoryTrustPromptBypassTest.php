<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperDirectoryTrustPromptBypassTest extends TestCase
{
    public function testWrapperForceTrustsCurrentWorkingDirectoryBeforeLaunch(): void
    {
        // The Go wrapper implements directory trust in codex/preexec.go via
        // EnsureProjectTrust(), which writes a [projects."<cwd>"] stanza with
        // trust_level = "trusted" into ~/.codex/config.toml before launching
        // the upstream Codex CLI.

        $preexecSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/preexec.go');
        self::assertIsString($preexecSource, 'Expected to be able to read codex/preexec.go');

        self::assertStringContainsString(
            'EnsureProjectTrust()',
            $preexecSource,
            'Wrapper should define EnsureProjectTrust helper for setting trust_level on project paths.'
        );
        // The Go source file stores the string literal as trust_level = \"trusted\"
        // (Go double-quote escaping inside a Sprintf format string).
        self::assertStringContainsString(
            'trust_level = \"trusted\"',
            $preexecSource,
            'Wrapper should enforce trusted project entries to suppress interactive trust prompts.'
        );

        // PreExec calls EnsureProjectTrust before the Codex binary is spawned.
        self::assertStringContainsString(
            'EnsureProjectTrust',
            $preexecSource,
            'Wrapper should include a pre-launch hook for trusting current project paths.'
        );

        // Confirm the trust call is wired into the PreExec launch sequence so it
        // runs before the upstream Codex binary is exec'd.
        $preExecFuncPos    = strpos($preexecSource, 'func PreExec(');
        $trustCallPos      = strpos($preexecSource, 'EnsureProjectTrust()');
        self::assertNotFalse($preExecFuncPos, 'Expected PreExec function definition in preexec.go');
        self::assertNotFalse($trustCallPos,   'Expected EnsureProjectTrust call in preexec.go');
        self::assertGreaterThan($preExecFuncPos, $trustCallPos === false ? 0 : $trustCallPos,
            'Expected EnsureProjectTrust to be called inside PreExec');

        // The exec.go wires PreExec into the run path before codex is spawned.
        $execSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        self::assertIsString($execSource, 'Expected to be able to read codex/exec.go');
        self::assertStringContainsString(
            'PreExec',
            $execSource,
            'exec.go should invoke PreExec (which trusts the cwd) before launching Codex.'
        );
    }
}
