<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class CdxWrapperHelpPassthroughTest extends TestCase
{
    public function testWrapperDefinesEarlyCodexHelpPassthroughDetector(): void
    {
        // The Go wrapper implements help passthrough detection in cmd/cdx/main.go
        // via isHelpPassthrough(). It is called at the very start of parseFlags()
        // before any wrapper side-effects (lock, sync, boot screen) are performed.

        $mainSource = file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        self::assertStringContainsString('func isHelpPassthrough(', $mainSource);
        self::assertStringContainsString('helpPassthrough', $mainSource);
        self::assertStringContainsString('--help', $mainSource);
        self::assertStringContainsString('-h', $mainSource);

        // The function iterates over args and checks for the help flag.
        self::assertStringContainsString('for _, a := range args', $mainSource);
        self::assertStringContainsString('a == "--help" || a == "-h"', $mainSource);
    }

    public function testWrapperBypassesBootstrapNoiseForCodexHelp(): void
    {
        $mainSource = file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        // Help passthrough execs straight into the real codex binary.
        $helpExecPos  = strpos($mainSource, 'syscall.Exec(cli, execArgv, os.Environ())');
        // Lock acquisition happens in lifecycle/run.go.
        $lockSource   = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ipc/lock.go');
        self::assertIsString($lockSource, 'Expected to be able to read ipc/lock.go');
        $lockFuncPos  = strpos($lockSource, 'func Acquire(');
        // Boot screen is rendered in ui/screen.go.
        $screenSource = file_get_contents(__DIR__ . '/../wrappers/cdx/internal/ui/screen.go');
        self::assertIsString($screenSource, 'Expected to be able to read ui/screen.go');
        $bootScreenPos = strpos($screenSource, 'PrintBootScreen');

        self::assertNotFalse($helpExecPos,  'Expected help passthrough syscall.Exec in main.go');
        self::assertNotFalse($lockFuncPos,  'Expected Acquire function in ipc/lock.go');
        self::assertNotFalse($bootScreenPos,'Expected PrintBootScreen in ui/screen.go');

        // Help passthrough is checked before the lock and boot screen paths run:
        // in main.go the helpPassthrough branch appears before lifecycle.Run and
        // before any ipc.Acquire call.
        $helpCheckPos    = strpos($mainSource, 'f.helpPassthrough');
        $lifecycleRunPos = strpos($mainSource, 'lifecycle.Run(');
        self::assertNotFalse($helpCheckPos,    'Expected f.helpPassthrough check in main.go');
        self::assertNotFalse($lifecycleRunPos, 'Expected lifecycle.Run call in main.go');
        self::assertLessThan($lifecycleRunPos, $helpCheckPos,
            'Expected help passthrough to be dispatched before lifecycle.Run (which acquires lock + boot screen)');

        self::assertStringContainsString('isHelpPassthrough', $mainSource);
    }

    public function testWrapperKeepsWrapperOwnedCommandsOutOfHelpPassthrough(): void
    {
        // Wrapper-owned subcommands (run, status, doctor, update, uninstall, …)
        // must never be hijacked by the help passthrough path. In the Go wrapper
        // this is enforced by wrapperOwnedSubcommands: isHelpPassthrough only
        // returns true for top-level --help/-h or help, and for the reserved Codex
        // subcommands (exec, login, review, …) — never for the wrapper's own
        // subcommands — so those flow through the normal switch/case dispatch.

        $mainSource = file_get_contents(__DIR__ . '/../wrappers/cdx/cmd/cdx/main.go');
        self::assertIsString($mainSource, 'Expected to be able to read cmd/cdx/main.go');

        self::assertStringContainsString(
            'wrapperOwnedSubcommands',
            $mainSource,
            'main.go should define wrapperOwnedSubcommands to gate passthrough from wrapper-owned tokens.'
        );
        self::assertStringContainsString(
            'reservedCodexSubcommands',
            $mainSource,
            'main.go should define reservedCodexSubcommands for the help-passthrough allow-list.'
        );
        // The passthrough exec only happens in the helpPassthrough branch, after
        // wrapperOwnedSubcommands are already handled by the switch/case.
        $ownedMapPos      = strpos($mainSource, 'wrapperOwnedSubcommands');
        $helpBranchPos    = strpos($mainSource, 'f.helpPassthrough');
        self::assertNotFalse($ownedMapPos,   'Expected wrapperOwnedSubcommands definition in main.go');
        self::assertNotFalse($helpBranchPos, 'Expected f.helpPassthrough branch in main.go');
        self::assertLessThan($helpBranchPos, $ownedMapPos,
            'Expected wrapperOwnedSubcommands to be defined before the help passthrough dispatch');
    }
}
