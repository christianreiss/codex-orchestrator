<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperPythonCompatibilityTest extends TestCase
{
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
}

