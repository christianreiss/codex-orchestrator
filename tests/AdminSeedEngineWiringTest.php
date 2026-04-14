<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminSeedEngineWiringTest extends TestCase
{
    public function testSeedModalExposesBothEngineRadios(): void
    {
        $html = file_get_contents(__DIR__ . '/../public/admin/index.html');
        self::assertIsString($html);

        self::assertStringContainsString('id="seedEngineCodex"', $html);
        self::assertStringContainsString('id="seedEngineClaude"', $html);
        self::assertStringContainsString('name="seedEngine"', $html);
    }

    public function testDashboardJsCapturesSelectedSeedEngineOnUploadHandoff(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);

        self::assertStringContainsString("input[name=\"seedEngine\"]:checked", $js);
        self::assertStringContainsString('seedSelectedEngine', $js);
    }

    public function testAuthUploadCallIncludesEngineInBody(): void
    {
        $js = file_get_contents(__DIR__ . '/../public/admin/assets/dashboard.js');
        self::assertIsString($js);

        self::assertMatchesRegularExpression(
            "/api\\('\\/admin\\/auth\\/upload'.*?engine:.*?seedSelectedEngine/s",
            $js
        );
    }

    public function testServerAcceptsEngineFieldOnAuthUpload(): void
    {
        $controller = file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controller);

        self::assertStringContainsString("array_key_exists('engine', \$payload)", $controller);
        self::assertStringContainsString("'engine' => \$engine", $controller);
    }
}
