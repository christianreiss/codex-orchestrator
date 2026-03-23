<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminOverviewRoutePricingModelCaptureTest extends TestCase
{
    public function testOverviewRouteCapturesPricingModelInController(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("#^/admin/overview$#", $routerSource, 'Expected /admin/overview route to exist');

        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString(
            '$pricingModel',
            $controllerSource,
            'Expected AdminOverviewController to reference $pricingModel.'
        );
    }

    public function testOverviewRoutePassesPricingModelToPricingService(): void
    {
        $controllerSource = @file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($controllerSource);

        self::assertStringContainsString(
            'latestPricing($this->pricingModel, false)',
            $controllerSource,
            'Expected /admin/overview pricing lookup to use $pricingModel.'
        );
    }
}
