<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperUninstallTest extends TestCase
{
    public function testUninstallIsDeferredUntilAfterConfigHelpersLoad(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        $caseStart = strpos($wrapperSource, '# Early one-shot commands');
        self::assertNotFalse($caseStart, 'Expected early one-shot commands block to exist');

        $caseEnd = strpos($wrapperSource, 'esac', $caseStart);
        self::assertNotFalse($caseEnd, 'Expected early one-shot commands block to end with esac');

        $caseBlock = substr($wrapperSource, $caseStart, $caseEnd - $caseStart);
        self::assertIsString($caseBlock);

        self::assertStringContainsString('--uninstall)', $caseBlock);
        self::assertStringContainsString('CODEX_DO_UNINSTALL=1', $caseBlock);
        self::assertStringNotContainsString('cmd_uninstall', $caseBlock);

        $loadSyncPos = strpos($wrapperSource, "load_sync_config() {");
        self::assertNotFalse($loadSyncPos, 'Expected load_sync_config() to be defined in wrapper');

        $guardPos = strpos($wrapperSource, 'if (( CODEX_DO_UNINSTALL )); then');
        self::assertNotFalse($guardPos, 'Expected wrapper to gate uninstall behind CODEX_DO_UNINSTALL');
        self::assertGreaterThan($loadSyncPos, $guardPos, 'Expected uninstall gate to run after load_sync_config() is defined');

        $callPos = strpos($wrapperSource, 'cmd_uninstall', $guardPos);
        self::assertNotFalse($callPos, 'Expected wrapper to call cmd_uninstall after uninstall gate');
    }
}

