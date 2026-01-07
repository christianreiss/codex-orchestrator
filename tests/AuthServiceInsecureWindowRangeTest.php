<?php

use PHPUnit\Framework\TestCase;

final class AuthServiceInsecureWindowRangeTest extends TestCase
{
    public function testInsecureWindowRangeConstants(): void
    {
        self::assertSame(0, App\Services\AuthService::MIN_INSECURE_WINDOW_MINUTES);
        self::assertSame(480, App\Services\AuthService::MAX_INSECURE_WINDOW_MINUTES);
        self::assertSame(10, App\Services\AuthService::DEFAULT_INSECURE_WINDOW_MINUTES);
    }
}
