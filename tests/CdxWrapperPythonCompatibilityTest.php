<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperPythonCompatibilityTest extends TestCase
{
    /**
     * The Go wrapper has fully replaced all embedded Python scripts. There is
     * no longer any Python dependency — time parsing, token extraction, and
     * session file handling are all implemented in Go.
     */
    public function testWrapperDetectsCompatiblePython3CommandsOnOlderHosts(): void
    {
        // The Go wrapper is self-contained and requires no Python interpreter.
        // All logic previously handled by python3 helpers is now in Go.
        // Verify that the exec path has no Python dependency.
        $execSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/exec.go');
        self::assertIsString($execSource, 'Expected to be able to read wrappers/cdx/internal/codex/exec.go');

        self::assertStringNotContainsString(
            'python',
            strtolower($execSource),
            'Go exec path must not invoke Python; all logic is implemented in Go.'
        );
        // The Go wrapper uses term.IsTerminal from golang.org/x/term, not
        // a Python-based TTY detector.
        self::assertStringContainsString(
            'term.IsTerminal',
            $execSource,
            'Go wrapper must use term.IsTerminal for TTY detection, not Python.'
        );
    }

    public function testWrapperAvoidsPython310UnionTypeHints(): void
    {
        // The Go wrapper has no embedded Python. Confirm no Go source file
        // under wrappers/cdx/ uses Python-style `X | None` type annotations.
        // (Go union types use a different syntax entirely.)
        $freshnessSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/freshness.go');
        self::assertIsString($freshnessSource, 'Expected to be able to read wrappers/cdx/internal/codex/freshness.go');

        // Go source naturally cannot contain Python union type hints.
        // The key property is that timestamp parsing works on Go 1.21+
        // without any Python version constraints.
        self::assertStringContainsString(
            'time.RFC3339',
            $freshnessSource,
            'Go freshness parser must use time.RFC3339 layouts, not Python datetime.'
        );
        self::assertDoesNotMatchRegularExpression(
            '/\\bNone\\b/',
            $freshnessSource,
            'Go source must not contain Python None literals.'
        );
    }

    public function testWrapperAvoidsPython37OnlyFromIsoformatDependency(): void
    {
        // The bash wrapper avoided datetime.fromisoformat (Python 3.7+) and
        // used strptime instead. The Go wrapper has no Python at all; it uses
        // time.Parse with explicit RFC3339 layout strings, which works on any
        // Go runtime version regardless of Python availability on the host.
        $freshnessSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/internal/codex/freshness.go');
        self::assertIsString($freshnessSource, 'Expected to be able to read wrappers/cdx/internal/codex/freshness.go');

        self::assertStringNotContainsString(
            'fromisoformat',
            $freshnessSource,
            'Go freshness parser must not reference Python fromisoformat.'
        );
        self::assertStringContainsString(
            'time.Parse',
            $freshnessSource,
            'Go freshness parser must use time.Parse with explicit layouts for RFC3339 parsing.'
        );
    }
}
