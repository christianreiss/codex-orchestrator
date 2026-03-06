<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminOverviewRoutePricingModelCaptureTest extends TestCase
{
    public function testOverviewRouteCapturesPricingModelInClosureUseList(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        $needle = "\$router->add('GET', '#^/admin/overview$#', function () use (";
        $start = strpos($routerSource, $needle);
        self::assertNotFalse($start, 'Expected to find /admin/overview route definition');

        $signatureEnd = strpos($routerSource, "{", $start);
        self::assertNotFalse($signatureEnd, 'Expected /admin/overview route signature to include a function body');

        $signature = substr($routerSource, $start, $signatureEnd - $start);

        self::assertStringContainsString(
            '$pricingModel',
            $signature,
            'Expected /admin/overview closure to capture $pricingModel in the use() list.'
        );
    }

    public function testOverviewRoutePassesPricingModelToPricingService(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString(
            '$pricingService->latestPricing($pricingModel, false);',
            $routerSource,
            'Expected /admin/overview pricing lookup to use $pricingModel.'
        );
    }
}
