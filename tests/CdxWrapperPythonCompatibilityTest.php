<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperPythonCompatibilityTest extends TestCase
{
    public function testWrapperDetectsCompatiblePython3CommandsOnOlderHosts(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringContainsString('detect_python3_compat_command()', $wrapperSource);
        self::assertStringContainsString('activate_python3_shim()', $wrapperSource);
        self::assertStringContainsString('python3.6', $wrapperSource);
        self::assertStringContainsString('python36', $wrapperSource);
        self::assertStringContainsString('platform-python', $wrapperSource);
        self::assertStringContainsString("python3() {\n      \"\$CODEX_PYTHON_BIN\" \"\$@\"\n    }", $wrapperSource);
    }

    public function testWrapperAvoidsPython310UnionTypeHints(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertDoesNotMatchRegularExpression(
            '/\\b\\w+\\s*\\|\\s*None\\b/',
            $wrapperSource,
            'Wrapper should not embed Python 3.10+ union type hints (e.g. `str | None`); AlmaLinux 9 ships Python 3.9.'
        );
        self::assertDoesNotMatchRegularExpression(
            '/\\bNone\\s*\\|\\s*\\w+\\b/',
            $wrapperSource,
            'Wrapper should not embed Python 3.10+ union type hints (e.g. `None | str`).'
        );
    }

    public function testWrapperAvoidsPython37OnlyFromIsoformatDependency(): void
    {
        $wrapperPath = __DIR__ . '/../bin/cdx';
        $wrapperSource = @file_get_contents($wrapperPath);
        self::assertIsString($wrapperSource, 'Expected to be able to read bin/cdx');

        self::assertStringNotContainsString(
            'datetime.datetime.fromisoformat',
            $wrapperSource,
            'Wrapper should keep RFC3339 parsing compatible with Python 3.6-era hosts.'
        );
        self::assertStringContainsString(
            'datetime.datetime.strptime',
            $wrapperSource,
            'Wrapper should fall back to strptime-based RFC3339 parsing for older Python 3 interpreters.'
        );
    }
}
