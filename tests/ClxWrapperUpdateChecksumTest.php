<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperUpdateChecksumTest extends TestCase
{
    public function testWrapperFetchesAndComparesExpectedSha(): void
    {
        // The Go wrapper receives the expected SHA256 for the new binary from the
        // /cron/check response (CronWrapperBlock.SHA256 field) and verifies the
        // download before the atomic swap — replacing the bash metadata-probe
        // approach (`/wrapper?engine=claude` + `.data.sha256 // empty`).

        // orchestrator/cron.go — CronWrapperBlock carries the SHA256 from the server.
        $cronOrchestratorGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/orchestrator/cron.go');
        self::assertIsString($cronOrchestratorGo, 'Expected to read wrappers/clx/internal/orchestrator/cron.go');
        self::assertStringContainsString('SHA256', $cronOrchestratorGo, 'Expected SHA256 field in cron wrapper block');

        // update/verify.go — rejects mismatches before atomic swap.
        $verifyGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/update/verify.go');
        self::assertIsString($verifyGo, 'Expected to read wrappers/clx/internal/update/verify.go');
        self::assertStringContainsString('sha256 mismatch', $verifyGo, 'Expected mismatch error in verify.go');

        // update.go — SelfUpdate calls VerifyChecksum and removes the tmp file on mismatch.
        $updateGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/update/update.go');
        self::assertIsString($updateGo, 'Expected to read wrappers/clx/internal/update/update.go');
        self::assertStringContainsString('VerifyChecksum', $updateGo, 'Expected VerifyChecksum call before atomic swap');
        self::assertStringContainsString('os.Remove(tmp)', $updateGo, 'Expected tmp cleanup on checksum failure');
    }

    public function testWrapperAbortsSelfUpdateWhenSha256Missing(): void
    {
        // cron.go — aborts the wrapper self-update when the server response is
        // missing SHA256, URL, or target version — refusing to install an
        // unverified binary (replaces "Server did not return a SHA256; falling back
        // to shebang sanity check." and "Refusing to install unverified wrapper").
        $cronGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/cron/cron.go');
        self::assertIsString($cronGo, 'Expected to read wrappers/clx/internal/cron/cron.go');

        self::assertStringContainsString('check.Wrapper.SHA256 == ""', $cronGo, 'Expected guard against empty SHA256');
        self::assertStringContainsString('wrapper update requested but metadata incomplete', $cronGo, 'Expected incomplete-metadata refusal');
    }
}
