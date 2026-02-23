<?php

use App\Http\ClientIp;
use PHPUnit\Framework\TestCase;

final class ClientIpTest extends TestCase
{
    private ?string $originalTrustForwarded = null;
    private ?string $originalTrustedCidrs = null;

    protected function setUp(): void
    {
        parent::setUp();
        $this->originalTrustForwarded = array_key_exists('TRUST_X_FORWARDED', $_ENV)
            ? (string) $_ENV['TRUST_X_FORWARDED']
            : (getenv('TRUST_X_FORWARDED') === false ? null : (string) getenv('TRUST_X_FORWARDED'));
        $this->originalTrustedCidrs = array_key_exists('TRUSTED_PROXY_CIDRS', $_ENV)
            ? (string) $_ENV['TRUSTED_PROXY_CIDRS']
            : (getenv('TRUSTED_PROXY_CIDRS') === false ? null : (string) getenv('TRUSTED_PROXY_CIDRS'));
    }

    protected function tearDown(): void
    {
        if ($this->originalTrustForwarded === null) {
            unset($_ENV['TRUST_X_FORWARDED'], $_SERVER['TRUST_X_FORWARDED']);
            putenv('TRUST_X_FORWARDED');
        } else {
            $_ENV['TRUST_X_FORWARDED'] = $this->originalTrustForwarded;
            $_SERVER['TRUST_X_FORWARDED'] = $this->originalTrustForwarded;
            putenv('TRUST_X_FORWARDED=' . $this->originalTrustForwarded);
        }

        if ($this->originalTrustedCidrs === null) {
            unset($_ENV['TRUSTED_PROXY_CIDRS'], $_SERVER['TRUSTED_PROXY_CIDRS']);
            putenv('TRUSTED_PROXY_CIDRS');
        } else {
            $_ENV['TRUSTED_PROXY_CIDRS'] = $this->originalTrustedCidrs;
            $_SERVER['TRUSTED_PROXY_CIDRS'] = $this->originalTrustedCidrs;
            putenv('TRUSTED_PROXY_CIDRS=' . $this->originalTrustedCidrs);
        }

        parent::tearDown();
    }

    private function setTrustedProxyEnv(string $trustForwarded, string $cidrs): void
    {
        $_ENV['TRUST_X_FORWARDED'] = $trustForwarded;
        $_SERVER['TRUST_X_FORWARDED'] = $trustForwarded;
        putenv('TRUST_X_FORWARDED=' . $trustForwarded);

        $_ENV['TRUSTED_PROXY_CIDRS'] = $cidrs;
        $_SERVER['TRUSTED_PROXY_CIDRS'] = $cidrs;
        putenv('TRUSTED_PROXY_CIDRS=' . $cidrs);
    }

    public function testSanitizesPortFromXRealIp(): void
    {
        $this->setTrustedProxyEnv('1', '10.0.0.0/8');
        self::assertSame('203.0.113.10', ClientIp::fromServer([
            'HTTP_X_REAL_IP' => '203.0.113.10:12345',
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }

    public function testSanitizesBracketedIpv6WithPortFromXRealIp(): void
    {
        $this->setTrustedProxyEnv('1', '10.0.0.0/8');
        self::assertSame('2001:db8::1', ClientIp::fromServer([
            'HTTP_X_REAL_IP' => '[2001:db8::1]:54321',
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }

    public function testUsesFirstValidIpFromXForwardedFor(): void
    {
        $this->setTrustedProxyEnv('1', '10.0.0.0/8');
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

    public function testIgnoresForwardedHeadersWhenRemoteAddrNotTrusted(): void
    {
        $this->setTrustedProxyEnv('1', '10.0.0.0/8');
        self::assertSame('203.0.113.50', ClientIp::fromServer([
            'HTTP_X_REAL_IP' => '198.51.100.7',
            'HTTP_X_FORWARDED_FOR' => '198.51.100.8',
            'REMOTE_ADDR' => '203.0.113.50',
        ]));
    }

    public function testIgnoresForwardedHeadersWhenTrustDisabled(): void
    {
        $this->setTrustedProxyEnv('0', '10.0.0.0/8');
        self::assertSame('10.0.0.2', ClientIp::fromServer([
            'HTTP_X_REAL_IP' => '198.51.100.7',
            'HTTP_X_FORWARDED_FOR' => '198.51.100.8',
            'REMOTE_ADDR' => '10.0.0.2',
        ]));
    }
}
