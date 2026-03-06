<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperSkillSyncDeleteImportTest extends TestCase
{
    public function testSkillSyncEmbeddedPythonImportsShutilForDeletePath(): void
    {
        $wrapperSource = file_get_contents(__DIR__ . '/../bin/cdx');
        self::assertIsString($wrapperSource);
        self::assertStringContainsString('import hashlib, json, os, pathlib, shutil, sys', $wrapperSource);
        self::assertStringContainsString('shutil.rmtree(target_path, ignore_errors=True)', $wrapperSource);
    }
}
