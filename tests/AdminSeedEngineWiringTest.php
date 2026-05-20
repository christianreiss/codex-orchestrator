<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSeedEngineWiringTest extends TestCase
{
    public function testSeedModalExposesBothEngineRadios(): void
    {
        // SvelteKit: engine radios live in the SeedAuthDialog component.
        $dialog = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/SeedAuthDialog.svelte');
        self::assertIsString($dialog);

        // The dialog renders RadioGroupItem elements for codex and claude engines.
        self::assertStringContainsString('value="codex"', $dialog);
        self::assertStringContainsString('value="claude"', $dialog);
        self::assertStringContainsString('RadioGroup', $dialog);
    }

    public function testDashboardJsCapturesSelectedSeedEngineOnUploadHandoff(): void
    {
        // SvelteKit: the selected engine is bound to a reactive $state variable.
        $dialog = file_get_contents(__DIR__ . '/../frontend/src/lib/components/hosts/SeedAuthDialog.svelte');
        self::assertIsString($dialog);

        // The engine state variable is used on the upload path.
        self::assertStringContainsString('engine', $dialog);
        self::assertStringContainsString('submitUpload', $dialog);
        self::assertStringContainsString('uploadAuth', $dialog);
    }

    public function testAuthUploadCallIncludesEngineInBody(): void
    {
        // SvelteKit: the upload mutation sends engine + payload to /admin/auth/upload.
        $auth = file_get_contents(__DIR__ . '/../frontend/src/lib/api/auth.ts');
        self::assertIsString($auth);

        self::assertStringContainsString('/admin/auth/upload', $auth);
        self::assertStringContainsString('engine', $auth);
        self::assertStringContainsString('payload', $auth);
    }

    public function testSeedCommandCallIncludesSelectedEngine(): void
    {
        // SvelteKit: the seed-command mutation POSTs the selected engine.
        $auth = file_get_contents(__DIR__ . '/../frontend/src/lib/api/auth.ts');
        self::assertIsString($auth);

        self::assertStringContainsString('/admin/auth/seed-command', $auth);
        self::assertStringContainsString('engine', $auth);
    }

    public function testServerAcceptsEngineFieldOnAuthUpload(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controller);

        self::assertStringContainsString("array_key_exists('engine', \$payload)", $controller);
        self::assertStringContainsString("'engine' => \$engine", $controller);
    }
}
