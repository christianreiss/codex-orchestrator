<?php

declare(strict_types=1);

use PHPUnit\Framework\TestCase;

final class AdminHistoryEndpointParamsTest extends TestCase
{
    public function testCostHistoryEndpointSupportsAdvancedQueryParams(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("#^/admin/usage/cost-history$#", $routerSource);
        self::assertStringContainsString('interval must be one of: day, week', $routerSource);
        self::assertStringContainsString('group_by must be one of: component, total', $routerSource);
        self::assertStringContainsString('include_tokens must be a boolean-like value', $routerSource);
        self::assertStringContainsString('historyAdvanced($days, $from, $until, $interval, $groupBy, $includeTokens)', $routerSource);
    }

    public function testChatGptHistoryEndpointSupportsAdvancedQueryParams(): void
    {
        $routerSource = @file_get_contents(__DIR__ . '/../public/index.php');
        self::assertIsString($routerSource);

        self::assertStringContainsString("#^/admin/chatgpt/usage/history$#", $routerSource);
        self::assertStringContainsString('interval must be one of: raw, hour, day', $routerSource);
        self::assertStringContainsString('lane must be one of: normal, spark, both', $routerSource);
        self::assertStringContainsString('window must be one of: primary, secondary, both', $routerSource);
        self::assertStringContainsString('historyAdvanced($days, $from, $until, $interval, $lane, $window)', $routerSource);
    }
}
