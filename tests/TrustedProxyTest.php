<?php

declare(strict_types=1);

use App\Http\TrustedProxy;
use PHPUnit\Framework\TestCase;

require_once __DIR__ . '/../vendor/autoload.php';

final class TrustedProxyTest extends TestCase
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

    public function testForwardedHeadersAreDisabledByDefault(): void
    {
        unset($_ENV['TRUST_X_FORWARDED'], $_SERVER['TRUST_X_FORWARDED']);
        unset($_ENV['TRUSTED_PROXY_CIDRS'], $_SERVER['TRUSTED_PROXY_CIDRS']);
        putenv('TRUST_X_FORWARDED');
        putenv('TRUSTED_PROXY_CIDRS');

        $this->assertFalse(TrustedProxy::forwardedHeadersTrusted([
            'REMOTE_ADDR' => '10.1.2.3',
        ]));
    }

    public function testForwardedHeadersRequireMatchingTrustedCidr(): void
    {
        $_ENV['TRUST_X_FORWARDED'] = '1';
        $_SERVER['TRUST_X_FORWARDED'] = '1';
        putenv('TRUST_X_FORWARDED=1');
        $_ENV['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8,2001:db8::/32';
        $_SERVER['TRUSTED_PROXY_CIDRS'] = '10.0.0.0/8,2001:db8::/32';
        putenv('TRUSTED_PROXY_CIDRS=10.0.0.0/8,2001:db8::/32');

        $this->assertTrue(TrustedProxy::forwardedHeadersTrusted([
            'REMOTE_ADDR' => '10.1.2.3',
        ]));
        $this->assertTrue(TrustedProxy::forwardedHeadersTrusted([
            'REMOTE_ADDR' => '2001:db8::10',
        ]));
        $this->assertFalse(TrustedProxy::forwardedHeadersTrusted([
            'REMOTE_ADDR' => '203.0.113.10',
        ]));
    }
}

