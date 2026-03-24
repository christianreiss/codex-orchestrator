<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperLaunchNoOpGuardTest extends TestCase
{
    public function testOtelConfigHelperReturnsSuccessWhenNothingIsExported(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            "done < <(otel_env_from_config_python 2>/dev/null || true)\n  return 0\n}",
            $wrapperSource,
            'OTel env helper should end with return 0 so an empty config does not abort cdx under set -e.'
        );
    }

    public function testCurrentProjectTrustHelperReturnsSuccessWhenNoPhysicalPathRewriteIsNeeded(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            "if [[ -n \"\$cwd_physical\" && \"\$cwd_physical\" != \"\$cwd_logical\" ]]; then\n    ensure_project_path_trusted_in_config \"\$cwd_physical\"\n  fi\n  return 0\n}",
            $wrapperSource,
            'Current-project trust helper should return success when pwd -P matches $PWD.'
        );
    }

    public function testRunLockOpenDoesNotSilenceWrapperStderrForTheRestOfTheRun(): void
    {
        $wrapperSource = @file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString(
            'if ! { exec {CDX_RUN_LOCK_FD}>>"$CDX_RUN_LOCK_PATH"; } 2>/dev/null; then',
            $wrapperSource,
            'Run-lock open should only suppress shell noise locally instead of permanently redirecting wrapper stderr.'
        );
        self::assertStringNotContainsString(
            'exec {CDX_RUN_LOCK_FD}>>"$CDX_RUN_LOCK_PATH" 2>/dev/null || {',
            $wrapperSource,
            'Run-lock open must not permanently redirect stderr to /dev/null.'
        );
    }
}
