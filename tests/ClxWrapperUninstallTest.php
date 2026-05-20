<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class ClxWrapperUninstallTest extends TestCase
{
    public function testUninstallDeletesDataDirAndSelf(): void
    {
        // uninstall.go — Run() removes ~/.clx tree (os.RemoveAll) and individual
        // config/auth files (os.Remove). Replaces the bash `clx_uninstall()`,
        // `rm -rf "$CLX_DATA_DIR"`, and `rm -f "$self_path"` fragments.
        $uninstallGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/uninstall/uninstall.go');
        self::assertIsString($uninstallGo, 'Expected to read wrappers/clx/internal/uninstall/uninstall.go');

        self::assertStringContainsString('func Run(', $uninstallGo, 'Expected Run() entrypoint');
        self::assertStringContainsString('os.RemoveAll', $uninstallGo, 'Expected recursive data-dir removal');
        self::assertStringContainsString('os.Remove', $uninstallGo, 'Expected individual file removal');
    }

    public function testUninstallCallsOrchestratorDeleteWithEngineClaude(): void
    {
        // uninstall.go — issues DELETE /auth?force=1&engine=claude for
        // server-side de-registration (replaces the bash
        // `clx_curl -X DELETE "${CLAUDE_SYNC_BASE_URL}/auth?engine=claude"`).
        $uninstallGo = file_get_contents(__DIR__ . '/../wrappers/clx/internal/uninstall/uninstall.go');
        self::assertIsString($uninstallGo);

        self::assertStringContainsString('http.MethodDelete', $uninstallGo, 'Expected HTTP DELETE method');
        self::assertStringContainsString('/auth?force=1&engine=claude', $uninstallGo, 'Expected DELETE /auth?engine=claude endpoint');
    }
}
