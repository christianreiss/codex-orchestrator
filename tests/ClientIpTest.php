<?php

use App\Http\ClientIp;
use PHPUnit\Framework\TestCase;

final class ClientIpTest extends TestCase
{
    public function testSanitizesPortFromXRealIp(): void
    {
        self::assertSame('203.0.113.10', ClientIp::fromServer([
            'HTTP_X_REAL_IP' => '203.0.113.10:12345',
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }

    public function testSanitizesBracketedIpv6WithPortFromXRealIp(): void
    {
        self::assertSame('2001:db8::1', ClientIp::fromServer([
            'HTTP_X_REAL_IP' => '[2001:db8::1]:54321',
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }

    public function testUsesFirstValidIpFromXForwardedFor(): void
    {
        self::assertSame('198.51.100.7', ClientIp::fromServer([
            'HTTP_X_FORWARDED_FOR' => 'not-an-ip, 198.51.100.7, 10.0.0.2',
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }

    public function testFallsBackToRemoteAddr(): void
    {
        self::assertSame('10.0.0.2', ClientIp::fromServer([
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }
}

