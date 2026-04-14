<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperUninstallTest extends TestCase
{
    public function testUninstallDeletesDataDirAndSelf(): void
    {
        $wrapper = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapper);

        self::assertStringContainsString('clx_uninstall()', $wrapper);
        self::assertStringContainsString('rm -rf "$CLX_DATA_DIR"', $wrapper);
        self::assertStringContainsString('rm -f "$self_path"', $wrapper);
    }

    public function testUninstallCallsOrchestratorDeleteWithEngineClaude(): void
    {
        $wrapper = file_get_contents(__DIR__ . '/../bin/clx');
        self::assertIsString($wrapper);

        self::assertStringContainsString('clx_curl -X DELETE "${CLAUDE_SYNC_BASE_URL}/auth?engine=claude"', $wrapper);
    }
}
