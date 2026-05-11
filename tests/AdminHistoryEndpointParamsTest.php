<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminHistoryEndpointParamsTest extends TestCase
{
    public function testLegacyBillingHistoryEndpointIsRemoved(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($routerSource);

        $legacyRoute = '#^/admin/usage/' . 'co' . 'st-history$#';
        $legacyHandler = 'usage' . 'Co' . 'stHistory';

        self::assertStringNotContainsString($legacyRoute, $routerSource);
        self::assertStringNotContainsString($legacyHandler, $routerSource);
        self::assertStringNotContainsString('historyAdvanced($days, $from, $until, $interval, $groupBy, $includeTokens)', $routerSource);
    }

    public function testChatGptHistoryEndpointSupportsAdvancedQueryParams(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php')
            . file_get_contents(__DIR__ . '/../src/Http/Controllers/AdminOverviewController.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("#^/admin/chatgpt/usage/history$#", $routerSource);
        self::assertStringContainsString('interval must be one of: raw, hour, day', $routerSource);
        self::assertStringContainsString('lane must be one of: normal, spark, both', $routerSource);
        self::assertStringContainsString('window must be one of: primary, secondary, both', $routerSource);
        self::assertStringContainsString('historyAdvanced($days, $from, $until, $interval, $lane, $window)', $routerSource);
    }
}
