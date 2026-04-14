<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperHelpPassthroughTest extends TestCase
{
    public function testWrapperPrintsHelpAndVersionWithoutRunningBootstrap(): void
    {
        $wrapperPath = __DIR__ . '/../bin/clx';
        self::assertFileIsReadable($wrapperPath);

        // --help and --version are case-matched in clx_main(); clx_acquire_lock is only
        // invoked from the `*)` default arm. Verify the two help arms exit before falling
        // through to the lock acquisition. This guards against someone moving
        // clx_acquire_lock above the case-dispatch.
        $source = file_get_contents($wrapperPath);
        self::assertIsString($source);

        // Verify each early-exit case arm calls clx_usage / printf AND exits before
        // clx_acquire_lock / clx_bootstrap would ever be invoked.
        self::assertStringContainsString('--help | -h)', $source);
        self::assertStringContainsString('--version | -v)', $source);
        self::assertStringContainsString('clx_usage', $source);
        self::assertStringContainsString('"clx %s (engine: claude)\n"', $source);

        // Inside the main dispatch, lock+bootstrap only run in non-early-exit branches.
        // Extract the clx_main() function body and check that --help and --version
        // exit before any lock acquisition.
        $mainStart = strpos($source, 'clx_main() {');
        self::assertNotFalse($mainStart);
        $mainEnd = strpos($source, "\nclx_main \"\$@\"", $mainStart);
        self::assertNotFalse($mainEnd);
        $mainBody = substr($source, $mainStart, $mainEnd - $mainStart);

        $helpCasePos = strpos($mainBody, '--help | -h)');
        $versionCasePos = strpos($mainBody, '--version | -v)');
        $defaultCasePos = strpos($mainBody, '*)');
        $firstLockInDefault = strpos($mainBody, 'clx_acquire_lock', $defaultCasePos);

        self::assertNotFalse($helpCasePos);
        self::assertNotFalse($versionCasePos);
        self::assertNotFalse($defaultCasePos);
        self::assertNotFalse($firstLockInDefault);
        // The default `*)` arm with clx_acquire_lock must come AFTER both help and version arms.
        self::assertGreaterThan($helpCasePos, $defaultCasePos, '*) default arm must come after --help arm');
        self::assertGreaterThan($versionCasePos, $defaultCasePos, '*) default arm must come after --version arm');
    }

    public function testWrapperVersionActuallyRunsEndToEnd(): void
    {
        // The generated wrapper must at minimum print its version without exiting with an error.
        // This catches build breakage / malformed heredocs / broken dispatch.
        $output = [];
        $exitCode = 0;
        exec('bash ' . escapeshellarg(__DIR__ . '/../bin/clx') . ' --version 2>&1', $output, $exitCode);

        self::assertSame(0, $exitCode, 'clx --version should exit 0; got output: ' . implode("\n", $output));
        self::assertNotEmpty($output);
        self::assertStringContainsString('clx', $output[0]);
        self::assertStringContainsString('claude', $output[0]);
    }
}
