<?php

use PHPUnit\Framework\TestCase;

final class AdminInsecureHostsModalStateTest extends TestCase
{
    public function testModalKeepsClosedHostsVisibleWithEnableAction(): void
    {
        // The SvelteKit dialog component replaces the old dashboard.js block.
        $dialog = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/InsecureApprovalsDialog.svelte');
        self::assertIsString($dialog);

        // "Window closed" is the toast message fired when disableHost.mutateAsync succeeds
        self::assertStringContainsString('Window closed', $dialog);
        // Both disable and enable mutations are wired
        self::assertStringContainsString('createDisableInsecureMutation', $dialog);
        self::assertStringContainsString('createEnableInsecureMutation', $dialog);
        // The closest-button event delegation pattern is replaced by direct
        // Svelte onclick handlers – verify the disable handler is present
        self::assertStringContainsString('$disableHost.mutateAsync', $dialog);
    }
}
