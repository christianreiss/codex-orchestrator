<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperProfileCommandReservationTest extends TestCase
{
    public function testWrapperReservesKnownCodexSubcommandsFromProfileShorthand(): void
    {
        // The Go wrapper uses a reservedCodexSubcommands map in main.go instead
        // of the bash is_reserved_codex_command() function.
        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read wrappers/cdx/cmd/cdx/main.go');

        self::assertStringContainsString(
            'reservedCodexSubcommands',
            $mainSource,
            'Go wrapper must declare a reservedCodexSubcommands map.'
        );
        // All reserved subcommand names from the original bash wrapper must
        // be present in the Go map.
        foreach (['exec', 'review', 'login', 'logout', 'mcp', 'mcp-server', 'app-server', 'completion', 'sandbox', 'debug', 'apply', 'resume', 'fork', 'cloud', 'features', 'help'] as $cmd) {
            self::assertStringContainsString(
                '"' . $cmd . '"',
                $mainSource,
                sprintf('Reserved Codex subcommand "%s" must appear in the Go wrapper.', $cmd)
            );
        }
    }

    public function testWrapperOnlyUsesProfileShorthandForNonReservedFirstArgs(): void
    {
        // The Go wrapper uses isProfileShorthand() which checks both
        // wrapperOwnedSubcommands and reservedCodexSubcommands before allowing
        // the legacy `cdx <profile-name>` shorthand dispatch.
        $mainSource = @file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read wrappers/cdx/cmd/cdx/main.go');

        self::assertStringContainsString(
            'isProfileShorthand',
            $mainSource,
            'Go wrapper must implement isProfileShorthand() to gate profile shorthand dispatch.'
        );
        self::assertStringContainsString(
            'reservedCodexSubcommands[sub]',
            $mainSource,
            'isProfileShorthand must reject reserved Codex subcommand tokens.'
        );
        // HasProfile is the Go equivalent of the bash profile-candidate lookup.
        self::assertStringContainsString(
            'codex.HasProfile',
            $mainSource,
            'Profile shorthand must confirm the profile exists via codex.HasProfile before dispatching.'
        );
    }
}
