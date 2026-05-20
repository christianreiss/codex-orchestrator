<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminToastUiTest extends TestCase
{
    public function testToastDeckExistsInAdminShell(): void
    {
        $toaster = file_get_contents(__DIR__ . '/../frontend/src/lib/components/feedback/Toaster.svelte');
        $this->assertIsString($toaster);

        // Toaster component wraps the Sonner library
        $this->assertStringContainsString('SonnerToaster', $toaster);

        $sonner = file_get_contents(__DIR__ . '/../frontend/src/lib/components/ui/sonner/sonner.svelte');
        $this->assertIsString($sonner);
        // Sonner applies a class that groups toasts
        $this->assertStringContainsString('toaster group', $sonner);
        // Toast deck positioned at top-right
        $this->assertStringContainsString('top-right', $sonner);
        // Rich colours enabled for success/error distinction
        $this->assertStringContainsString('richColors', $sonner);

        $layout = file_get_contents(__DIR__ . '/../frontend/src/routes/+layout.svelte');
        $this->assertIsString($layout);
        // Toaster is mounted globally in the root layout
        $this->assertStringContainsString('<Toaster />', $layout);
    }

    public function testToastStylesAndHandlersExist(): void
    {
        $sonner = file_get_contents(__DIR__ . '/../frontend/src/lib/components/ui/sonner/sonner.svelte');
        $this->assertIsString($sonner);

        // Toast classes mirror shadcn-style card appearance
        $this->assertStringContainsString('group-[.toaster]:bg-background', $sonner);
        $this->assertStringContainsString('group-[.toaster]:text-foreground', $sonner);
        // Toast close button is rendered
        $this->assertStringContainsString('closeButton', $sonner);
        // Success / error / action button classes defined
        $this->assertStringContainsString('actionButton', $sonner);

        $hostsPage = file_get_contents(__DIR__ . '/../frontend/src/routes/hosts/+page.svelte');
        $this->assertIsString($hostsPage);
        // svelte-sonner toast() is called in the hosts page (as an example of toast usage)
        $this->assertStringContainsString('toast', $hostsPage);
    }
}
